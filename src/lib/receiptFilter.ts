import type { ReceiptStatus, ReceiptSummary } from '../types'

export const STATUS_FILTERS = ['All', 'Approved', 'Pending'] as const
export type StatusFilter = typeof STATUS_FILTERS[number]

export interface ReceiptFilter {
  search: string
  status: StatusFilter
}

export const EMPTY_FILTER: ReceiptFilter = { search: '', status: 'All' }

/** Apply the search + status filter used by the All Receipts list. */
export function filterReceipts(receipts: ReceiptSummary[], filter: ReceiptFilter): ReceiptSummary[] {
  const q = filter.search.trim().toLowerCase()
  return receipts.filter(r => {
    const matchSearch =
      !q ||
      (r.store_name?.toLowerCase().includes(q) ?? false) ||
      (r.receipt_date?.includes(filter.search.trim()) ?? false)
    const matchStatus =
      filter.status === 'All' ||
      (filter.status === 'Approved' && r.status === 'verified') ||
      (filter.status === 'Pending' && r.status !== 'verified')
    return matchSearch && matchStatus
  })
}

export interface Adjacency {
  prevId: number | null
  nextId: number | null
  /** 0-based position of the current receipt in the list, or -1 if absent. */
  index: number
  total: number
}

/** Find the previous/next receipt ids relative to `currentId` within a list. */
export function adjacentIds(receipts: ReceiptSummary[], currentId: number): Adjacency {
  const index = receipts.findIndex(r => r.id === currentId)
  return {
    prevId: index > 0 ? receipts[index - 1].id : null,
    nextId: index >= 0 && index < receipts.length - 1 ? receipts[index + 1].id : null,
    index,
    total: receipts.length,
  }
}

/** True for receipts that have been read and are waiting for the user's approval. */
export function awaitsApproval(r: Pick<ReceiptSummary, 'status'>): boolean {
  return r.status === 'pending' || r.status === 'review'
}

/**
 * Name to show for a receipt in lists. One that is still being read has no
 * store name yet, so it gets a placeholder instead of "Unknown Store".
 */
export function receiptDisplayName(
  r: Pick<ReceiptSummary, 'store_name' | 'status'>, unknown = 'Unknown Store',
): string {
  const named = r.store_name && r.store_name !== 'Unknown Store' ? r.store_name : null
  if (r.status === 'processing' || r.status === 'failed') return named ?? 'New receipt'
  return r.store_name ?? unknown
}

/** Short note replacing the item count for a receipt that hasn't been read (yet). */
export function receiptStatusNote(r: Pick<ReceiptSummary, 'status'>): string | null {
  if (r.status === 'processing') return 'being read…'
  if (r.status === 'failed') return 'could not be read'
  return null
}

/** Badge variant for a receipt status (anything unrecognised reads as pending). */
export function statusVariant(status: string | null | undefined): ReceiptStatus {
  return status === 'verified' || status === 'review' || status === 'processing' || status === 'failed'
    ? status
    : 'pending'
}
