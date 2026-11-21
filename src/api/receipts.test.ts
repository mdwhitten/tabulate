import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// client.ts reads window.location at import time; tests run in node.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('./client', () => ({
  apiUrl: (path: string) => `/api${path}`,
  apiFetch,
}))

import { enqueueReceipt, getProcessingStatus, reprocessReceipt, resultFromReceipt } from './receipts'
import type { Receipt } from '../types'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  apiFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('enqueueReceipt', () => {
  it('posts the scan and its original to the enqueue endpoint', async () => {
    fetchMock.mockResolvedValue(json({ receipt_id: 42, status: 'processing' }, 202))
    const original = new File(['orig'], 'IMG_1.jpg', { type: 'image/jpeg' })
    const out = await enqueueReceipt(new Blob(['x'], { type: 'image/jpeg' }), original)

    expect(out).toEqual({ receipt_id: 42, status: 'processing' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/receipts/enqueue')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    // A corrected scan is a nameless Blob; the original keeps its file name.
    expect((form.get('file') as File).name).toBe('scan.jpg')
    expect((form.get('original') as File).name).toBe('IMG_1.jpg')
  })

  it('sends only the file when there is no separate original', async () => {
    fetchMock.mockResolvedValue(json({ receipt_id: 1, status: 'processing' }, 202))
    await enqueueReceipt(new File(['x'], 'r.pdf', { type: 'application/pdf' }))
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect((form.get('file') as File).name).toBe('r.pdf')
    expect(form.has('original')).toBe(false)
  })

  it('throws the server detail for a rejected upload', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'File too large (max 20 MB)' }, 413))
    await expect(enqueueReceipt(new Blob(['x']))).rejects.toThrow('Upload failed: File too large (max 20 MB)')
  })

  it('falls back to the status text when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(enqueueReceipt(new Blob(['x']))).rejects.toThrow('Upload failed: Bad Gateway')
  })

  it('propagates a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(enqueueReceipt(new Blob(['x']))).rejects.toThrow('Failed to fetch')
  })
})

describe('getProcessingStatus', () => {
  it('asks for all ids in one request', async () => {
    apiFetch.mockResolvedValue([])
    await getProcessingStatus([3, 7, 9])
    expect(apiFetch).toHaveBeenCalledWith('/receipts/status?ids=3,7,9')
  })

  it('makes no request for an empty list', async () => {
    expect(await getProcessingStatus([])).toEqual([])
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('reprocessReceipt', () => {
  it('posts to the reprocess endpoint', async () => {
    apiFetch.mockResolvedValue({ receipt_id: 5, status: 'processing' })
    await reprocessReceipt(5)
    expect(apiFetch).toHaveBeenCalledWith('/receipts/5/reprocess', { method: 'POST' })
  })
})

describe('resultFromReceipt', () => {
  it('rebuilds a review-ready result from a stored receipt', () => {
    const receipt: Receipt = {
      id: 8,
      store_name: 'ALDI',
      receipt_date: '2026-03-01',
      scanned_at: '2026-03-01T10:00:00',
      status: 'pending',
      total: 6.49,
      tax: 0.5,
      total_verified: true,
      verification_message: null,
      ocr_raw: null,
      image_path: '/data/images/a.jpg',
      thumbnail_path: '/data/images/thumb_a.jpg',
      items: [{
        id: 1, receipt_id: 8, raw_name: 'BANANAS', clean_name: 'Bananas',
        category: 'Produce', category_source: 'ai', price: 1.99, quantity: 1,
      }],
    }
    expect(resultFromReceipt(receipt)).toMatchObject({
      receipt_id: 8,
      store_name: 'ALDI',
      receipt_date: '2026-03-01',
      total: 6.49,
      total_verified: true,
      verification_message: '',
      categorization_failed: false,
      thumbnail_path: '/data/images/thumb_a.jpg',
      items: receipt.items,
    })
  })

  it('never yields a null store name', () => {
    const receipt = { id: 1, store_name: null, items: [] } as unknown as Receipt
    expect(resultFromReceipt(receipt).store_name).toBe('Unknown Store')
  })
})
