import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// client.ts reads window.location at import time; tests run in node.
vi.mock('./client', () => ({
  apiUrl: (path: string) => `/api${path}`,
  apiFetch: vi.fn(),
}))

import { uploadReceipt } from './receipts'
import type { ProcessingResult, UploadProgressEvent } from './receipts'

const RESULT: ProcessingResult = {
  receipt_id: 42,
  store_name: 'H-E-B',
  receipt_date: '2026-02-15',
  ocr_raw: null,
  subtotal: 10,
  tax: 1,
  discounts: 0,
  total: 11,
  total_verified: true,
  verification_message: 'Total matches sum of items.',
  thumbnail_path: null,
  categorization_failed: false,
  items: [],
}

/** A Response whose body streams the given string chunks. */
function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  })
}

/** One server-sent event, as the backend writes it. */
const line = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadReceipt', () => {
  it('posts the form to the streaming endpoint', async () => {
    fetchMock.mockResolvedValue(streamResponse([line({ type: 'result', data: RESULT })]))
    const original = new Blob(['orig'], { type: 'image/jpeg' })
    await uploadReceipt(new Blob(['x'], { type: 'image/jpeg' }), [[0, 0], [1, 1]], original)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/receipts/upload-stream')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect(form.get('crop_corners')).toBe('[[0,0],[1,1]]')
    expect(form.get('original')).toBeInstanceOf(Blob)
  })

  it('fires progress callbacks in order and resolves with the result', async () => {
    // Lines deliberately split across chunks.
    const text =
      line({ type: 'progress', stage: 'preparing' }) +
      line({ type: 'progress', stage: 'reading', method: 'ai' }) +
      line({ type: 'progress', stage: 'reading', method: 'ai', items: 2 }) +
      line({ type: 'progress', stage: 'checking' }) +
      line({ type: 'progress', stage: 'categorizing' }) +
      line({ type: 'progress', stage: 'saving' }) +
      line({ type: 'result', data: RESULT })
    const chunks = [text.slice(0, 17), text.slice(17, 90), text.slice(90, 91), text.slice(91)]
    fetchMock.mockResolvedValue(streamResponse(chunks))

    const events: UploadProgressEvent[] = []
    const result = await uploadReceipt(new Blob(['x']), null, null, e => events.push(e))

    expect(result).toEqual(RESULT)
    expect(events.map(e => e.stage)).toEqual([
      'preparing', 'reading', 'reading', 'checking', 'categorizing', 'saving',
    ])
    expect(events[2]).toMatchObject({ method: 'ai', items: 2 })
  })

  it('works when a buffering proxy delivers everything in one chunk without a trailing newline', async () => {
    const text = line({ type: 'progress', stage: 'preparing' }) + JSON.stringify({ type: 'result', data: RESULT })
    fetchMock.mockResolvedValue(streamResponse([text]))
    const onProgress = vi.fn()
    await expect(uploadReceipt(new Blob(['x']), null, null, onProgress)).resolves.toEqual(RESULT)
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('ignores unknown event types and malformed lines', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue(streamResponse([
      line({ type: 'heartbeat' }),
      'not json\n',
      line({ type: 'progress', stage: 'mystery', foo: 1 }),
      line({ type: 'result', data: RESULT }),
    ]))
    const onProgress = vi.fn()
    await expect(uploadReceipt(new Blob(['x']), null, null, onProgress)).resolves.toEqual(RESULT)
    // Unknown stages are passed through; the UI reducer ignores them.
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'mystery' }))
    warn.mockRestore()
  })

  it('reads SSE events split across chunks and skips comment lines', async () => {
    const text = ': stream open\n\n' + line({ type: 'progress', stage: 'preparing' }) + line({ type: 'result', data: RESULT })
    fetchMock.mockResolvedValue(streamResponse([text.slice(0, 7), text.slice(7, 40), text.slice(40)]))
    const onProgress = vi.fn()
    await expect(uploadReceipt(new Blob(['x']), null, null, onProgress)).resolves.toEqual(RESULT)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith({ type: 'progress', stage: 'preparing' })
  })

  it('still accepts plain NDJSON lines', async () => {
    fetchMock.mockResolvedValue(streamResponse([
      JSON.stringify({ type: 'progress', stage: 'preparing' }) + '\n',
      JSON.stringify({ type: 'result', data: RESULT }) + '\n',
    ]))
    const onProgress = vi.fn()
    await expect(uploadReceipt(new Blob(['x']), null, null, onProgress)).resolves.toEqual(RESULT)
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('works without an onProgress callback', async () => {
    fetchMock.mockResolvedValue(streamResponse([
      line({ type: 'progress', stage: 'preparing' }),
      line({ type: 'result', data: RESULT }),
    ]))
    await expect(uploadReceipt(new Blob(['x']))).resolves.toEqual(RESULT)
  })

  it('throws on an error event', async () => {
    fetchMock.mockResolvedValue(streamResponse([
      line({ type: 'progress', stage: 'preparing' }),
      line({ type: 'error', status: 500, detail: 'Could not read receipt' }),
    ]))
    await expect(uploadReceipt(new Blob(['x']))).rejects.toThrow('Upload failed: Could not read receipt')
  })

  it('throws on a non-2xx response with the JSON detail', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'Unsupported file type' }), {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: { 'Content-Type': 'application/json' },
    }))
    await expect(uploadReceipt(new Blob(['x']))).rejects.toThrow('Upload failed: Unsupported file type')
  })

  it('falls back to the status text when a non-2xx body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 413, statusText: 'Payload Too Large' }))
    await expect(uploadReceipt(new Blob(['x']))).rejects.toThrow('Upload failed: Payload Too Large')
  })

  it('throws when the stream ends without a result', async () => {
    fetchMock.mockResolvedValue(streamResponse([
      line({ type: 'progress', stage: 'preparing' }),
      line({ type: 'progress', stage: 'reading', method: 'ai' }),
    ]))
    await expect(uploadReceipt(new Blob(['x']))).rejects.toThrow(/^Upload failed: /)
  })
})
