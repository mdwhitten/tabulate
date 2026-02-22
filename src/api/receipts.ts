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
  items: Receipt['items']
}

export async function listReceipts(): Promise<ReceiptSummary[]> {
  return apiFetch<ReceiptSummary[]>('/receipts')
}

export async function getReceipt(id: number): Promise<Receipt> {
  return apiFetch<Receipt>(`/receipts/${id}`)
}

export async function uploadReceipt(
  file: File,
  cropCorners?: [number, number][] | null,
): Promise<ProcessingResult> {
  const form = new FormData()
  form.append('file', file)
  if (cropCorners) {
    form.append('crop_corners', JSON.stringify(cropCorners))
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

export function receiptThumbnailUrl(id: number): string {
  return apiUrl(`/receipts/${id}/thumbnail`)
}

export function receiptImageUrl(id: number): string {
  return apiUrl(`/receipts/${id}/image`)
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

/** Apply a crop to an existing receipt (overwrites image + thumbnail). */
export async function cropReceipt(
  receiptId: number,
  corners: CropCorners,
): Promise<{ status: string; thumbnail_path: string }> {
  const res = await fetch(apiUrl(`/receipts/${receiptId}/crop`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corners }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try { const b = await res.json(); detail = b.detail ?? detail } catch { /* ignore */ }
    throw new Error(`Crop failed: ${detail}`)
  }
  return res.json()
}
