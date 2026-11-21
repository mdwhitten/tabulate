import { apiFetch, apiUrl } from './client'
import { splitNdjson, flushNdjson, eventPayload } from '../lib/ndjson'
import type { Receipt, ReceiptSummary, SaveReceiptBody, DuplicateMatch } from '../types'

export interface ProcessingResult {
  receipt_id: number
  store_name: string
  receipt_date: string | null
  /** Raw OCR text; null when the receipt was read by Claude Vision directly. */
  ocr_raw: string | null
  subtotal: number | null
  tax: number | null
  discounts: number
  total: number | null
  total_verified: boolean
  verification_message: string
  thumbnail_path: string | null
  categorization_failed: boolean
  items: Receipt['items']
}

export async function listReceipts(): Promise<ReceiptSummary[]> {
  return apiFetch<ReceiptSummary[]>('/receipts')
}

export async function getReceipt(id: number): Promise<Receipt> {
  return apiFetch<Receipt>(`/receipts/${id}`)
}

/**
 * A progress event streamed by POST /receipts/upload-stream. Stages the UI
 * doesn't know about (and extra fields) must be tolerated.
 */
export interface UploadProgressEvent {
  type: 'progress'
  stage: 'preparing' | 'reading' | 'rechecking' | 'checking' | 'categorizing' | 'saving' | (string & {})
  /** For `reading`: 'ai' (Claude Vision) or 'ocr' (Tesseract fallback). */
  method?: string
  /** For `reading` with method 'ai': items found so far. */
  items?: number
  /** For `rechecking`: number of problems that triggered the re-check. */
  problems?: number
}

type UploadStreamEvent =
  | UploadProgressEvent
  | { type: 'result'; data: ProcessingResult }
  | { type: 'error'; status?: number; detail?: string }

/**
 * Upload a receipt and process it, streaming progress.
 *
 * The server replies with server-sent events (one `data: {...}` line per
 * event): zero or more `progress` events followed by a final `result`
 * (resolved) or `error` (thrown). Validation failures come back as an ordinary
 * non-2xx JSON response before any streaming.
 */
export async function uploadReceipt(
  file: File | Blob,
  cropCorners?: [number, number][] | null,
  original?: File | Blob | null,
  onProgress?: (event: UploadProgressEvent) => void,
): Promise<ProcessingResult> {
  const form = new FormData()
  // A client-side perspective-corrected scan arrives as a Blob (no name).
  const filename = file instanceof File ? file.name : 'scan.jpg'
  form.append('file', file, filename)
  if (cropCorners) {
    form.append('crop_corners', JSON.stringify(cropCorners))
  }
  // When `file` is a client-corrected scan, also send the pristine original so
  // the crop can be redone from it later.
  if (original) {
    form.append('original', original, original instanceof File ? original.name : 'original.jpg')
  }
  const res = await fetch(apiUrl('/receipts/upload-stream'), { method: 'POST', body: form })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); detail = b.detail ?? detail } catch { /* ignore */ }
    throw new Error(`Upload failed: ${detail}`)
  }

  // Held in an object so assignments inside the line handler stay visible to TS.
  const outcome: { result?: ProcessingResult; error?: string } = {}

  // Returns true once a terminal (result / error) event has been seen.
  const handleLine = (line: string): boolean => {
    const payload = eventPayload(line)
    if (payload === null) return false
    let event: UploadStreamEvent
    try {
      event = JSON.parse(payload) as UploadStreamEvent
    } catch {
      console.warn('Ignoring malformed upload-stream line:', line)
      return false
    }
    if (!event || typeof event !== 'object') return false
    if (event.type === 'progress') {
      if (typeof event.stage === 'string') onProgress?.(event)
      return false
    }
    if (event.type === 'result') {
      outcome.result = event.data
      return true
    }
    if (event.type === 'error') {
      outcome.error = event.detail || (event.status ? `HTTP ${event.status}` : 'unknown error')
      return true
    }
    return false   // unknown event type — ignore
  }

  const consume = (lines: string[]): boolean => lines.some(handleLine)

  if (res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let rest = ''
    let finished = false
    try {
      while (!finished) {
        const { value, done } = await reader.read()
        if (done) {
          const tail = splitNdjson(rest, decoder.decode())
          finished = consume([...tail.lines, ...flushNdjson(tail.rest)])
          break
        }
        const split = splitNdjson(rest, decoder.decode(value, { stream: true }))
        rest = split.rest
        finished = consume(split.lines)
      }
    } finally {
      // Stop reading once the terminal event arrived (no-op if the stream ended).
      reader.cancel().catch(() => { /* ignore */ })
    }
  } else {
    // No streaming body available — parse the whole response at once.
    const { lines, rest } = splitNdjson('', await res.text())
    consume([...lines, ...flushNdjson(rest)])
  }

  if (outcome.error !== undefined) throw new Error(`Upload failed: ${outcome.error}`)
  if (!outcome.result) throw new Error('Upload failed: connection closed before processing finished')
  return outcome.result
}

export async function saveReceipt(
  id: number,
  body: SaveReceiptBody,
): Promise<{ status: string }> {
  return apiFetch(`/receipts/${id}/save`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function checkDuplicates(
  total: number | null,
  receiptDate: string | null,
  excludeId?: number,
): Promise<DuplicateMatch[]> {
  if (total == null || !receiptDate) return []
  const params = new URLSearchParams({
    total: String(total),
    receipt_date: receiptDate,
  })
  if (excludeId != null) params.set('exclude_id', String(excludeId))
  return apiFetch<DuplicateMatch[]>(`/receipts/check-duplicates?${params}`)
}

export async function deleteReceipt(id: number): Promise<void> {
  return apiFetch(`/receipts/${id}`, { method: 'DELETE' })
}

export interface RecategorizeResult {
  status: string
  categorization_failed: boolean
  updated: number
}

export async function recategorizeReceipt(id: number): Promise<RecategorizeResult> {
  return apiFetch<RecategorizeResult>(`/receipts/${id}/recategorize`, { method: 'POST' })
}

export function receiptThumbnailUrl(id: number): string {
  return apiUrl(`/receipts/${id}/thumbnail`)
}

export function receiptImageUrl(id: number): string {
  return apiUrl(`/receipts/${id}/image`)
}

/** URL of the pristine pre-crop image (falls back to the displayed image server-side). */
export function receiptOriginalUrl(id: number): string {
  return apiUrl(`/receipts/${id}/original`)
}

// ── Crop / Edge detection ──────────────────────────────────────────────────

export type CropCorners = [[number, number], [number, number], [number, number], [number, number]]

/** Detect receipt edges on a file before upload (returns fractional corners TL→TR→BR→BL). */
export async function detectEdgesRaw(file: File): Promise<CropCorners | null> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(apiUrl('/receipts/detect-edges-raw'), { method: 'POST', body: form })
  if (!res.ok) return null
  const data = await res.json()
  return data.corners ?? null
}

/** Detect receipt edges on an already-saved receipt image. */
export async function detectEdges(receiptId: number): Promise<CropCorners | null> {
  const res = await fetch(apiUrl(`/receipts/${receiptId}/detect-edges`))
  if (!res.ok) return null
  const data = await res.json()
  return data.corners ?? null
}

/**
 * Replace an existing receipt's displayed/OCR'd image with a client re-cropped &
 * perspective-corrected image. The server keeps the pristine original so the crop
 * stays reversible.
 */
export async function replaceReceiptImage(
  receiptId: number,
  image: Blob,
): Promise<{ status: string; thumbnail_path: string }> {
  const form = new FormData()
  form.append('file', image, 'scan.jpg')
  const res = await fetch(apiUrl(`/receipts/${receiptId}/replace-image`), {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); detail = b.detail ?? detail } catch { /* ignore */ }
    throw new Error(`Image replace failed: ${detail}`)
  }
  return res.json()
}
