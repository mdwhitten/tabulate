import { apiFetch, apiUrl } from './client'
import type { Receipt, ReceiptSummary, SaveReceiptBody, DuplicateMatch } from '../types'

export interface ProcessingResult {
  receipt_id: number
  store_name: string
  receipt_date: string | null
  ocr_raw: string
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

export async function uploadReceipt(
  file: File | Blob,
  cropCorners?: [number, number][] | null,
  original?: File | Blob | null,
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
  const res = await fetch(apiUrl('/receipts/upload'), { method: 'POST', body: form })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); detail = b.detail ?? detail } catch { /* ignore */ }
    throw new Error(`Upload failed: ${detail}`)
  }
  return res.json() as Promise<ProcessingResult>
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
