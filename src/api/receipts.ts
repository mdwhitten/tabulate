import { apiFetch, apiUrl } from './client'
import type { Receipt, ReceiptStatus, ReceiptSummary, SaveReceiptBody, DuplicateMatch } from '../types'

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
 * Progress of a receipt being processed, as reported by GET /receipts/status.
 * Stages the UI doesn't know about (and extra fields) must be tolerated.
 */
export interface UploadProgressEvent {
  type: 'progress'
  stage: 'queued' | 'preparing' | 'reading' | 'rechecking' | 'checking' | 'categorizing' | 'saving' | (string & {})
  /** For `reading`: 'ai' (Claude Vision) or 'ocr' (Tesseract fallback). */
  method?: string
  /** For `reading` with method 'ai': items found so far. */
  items?: number
  /** For `rechecking`: number of problems that triggered the re-check. */
  problems?: number
}

/** An upload the server has accepted and is processing in the background. */
export interface EnqueuedReceipt {
  receipt_id: number
  status: string
}

async function errorDetail(res: Response): Promise<string> {
  let detail = res.statusText
  try { const b = await res.json(); detail = b.detail ?? detail } catch { /* ignore */ }
  return detail
}

/**
 * Hand a receipt to the server. Resolves as soon as the server has stored the
 * upload (HTTP 202) — from then on it is processed in the background and
 * survives this page closing or losing its connection. Follow it with
 * `getProcessingStatus`.
 *
 * When `file` is a client-side perspective-corrected scan, pass the pristine
 * image as `original` so the crop can be redone from it later.
 */
export async function enqueueReceipt(
  file: File | Blob,
  original?: File | Blob | null,
  signal?: AbortSignal,
): Promise<EnqueuedReceipt> {
  const form = new FormData()
  // A client-side perspective-corrected scan arrives as a Blob (no name).
  form.append('file', file, file instanceof File ? file.name : 'scan.jpg')
  if (original) {
    form.append('original', original, original instanceof File ? original.name : 'original.jpg')
  }
  const res = await fetch(apiUrl('/receipts/enqueue'), { method: 'POST', body: form, signal })
  if (!res.ok) throw new Error(`Upload failed: ${await errorDetail(res)}`)
  return res.json()
}

/** Polled state of an enqueued receipt. */
export interface ReceiptProcessingStatus {
  id: number
  status: ReceiptStatus
  /** Live stage while `status` is 'processing'. */
  progress: Omit<UploadProgressEvent, 'type'> | null
  /** Why it failed, when `status` is 'failed'. */
  error: string | null
  /** The processed receipt, once done — null if the server no longer remembers it. */
  result: ProcessingResult | null
}

/** Processing state of the given receipts. Receipts that no longer exist are left out. */
export async function getProcessingStatus(ids: number[]): Promise<ReceiptProcessingStatus[]> {
  if (ids.length === 0) return []
  return apiFetch<ReceiptProcessingStatus[]>(`/receipts/status?ids=${ids.join(',')}`)
}

/** Retry a receipt whose processing failed (it goes back to 'processing'). */
export async function reprocessReceipt(id: number): Promise<EnqueuedReceipt> {
  return apiFetch<EnqueuedReceipt>(`/receipts/${id}/reprocess`, { method: 'POST' })
}

/**
 * A ProcessingResult rebuilt from a stored receipt, for when the server no
 * longer has the original result (e.g. it restarted mid-batch).
 */
export function resultFromReceipt(receipt: Receipt): ProcessingResult {
  return {
    receipt_id: receipt.id,
    store_name: receipt.store_name ?? 'Unknown Store',
    receipt_date: receipt.receipt_date,
    ocr_raw: receipt.ocr_raw,
    subtotal: null,
    tax: receipt.tax,
    discounts: 0,
    total: receipt.total,
    total_verified: receipt.total_verified,
    verification_message: receipt.verification_message ?? '',
    thumbnail_path: receipt.thumbnail_path,
    categorization_failed: false,
    items: receipt.items,
  }
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
