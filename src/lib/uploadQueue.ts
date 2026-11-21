/**
 * State of the receipts being uploaded from the upload modal.
 *
 * Each receipt is sent to the server as soon as its crop is confirmed, and is
 * then processed there in the background. An item moves through:
 *
 *   uploading ──► processing ──► ready
 *       │              └───────► failed         (server couldn't read it; retryable)
 *       └───────► upload-failed                 (never reached the server; retryable)
 *
 * Once an item is past `uploading` the server has it, so the modal — or the
 * whole tab — can be closed without losing it. Kept free of React/DOM so the
 * transitions are unit-testable.
 */
import type { ProcessingResult, ReceiptProcessingStatus } from '../api/receipts'
import {
  describeUploadEvent,
  initialUploadProgress,
  uploadProgressReducer,
} from './uploadProgress'
import type { UploadProgressState } from './uploadProgress'

export type UploadPhase = 'uploading' | 'upload-failed' | 'processing' | 'ready' | 'failed'

export interface UploadItem {
  /** Stable id of the picked file. */
  key: number
  name: string
  phase: UploadPhase
  /** Server id, known once the upload has been accepted. */
  receiptId: number | null
  /** Step-list state (single-receipt view). */
  progress: UploadProgressState
  /** One-line description of the current stage (batch view). */
  stageText: string | null
  error: string | null
  result: ProcessingResult | null
}

export type UploadQueueAction =
  /** An upload was started (or restarted after `upload-failed`). */
  | { type: 'start'; key: number; name: string }
  /** The server stored the upload and began processing it. */
  | { type: 'accepted'; key: number; receiptId: number }
  | { type: 'upload-failed'; key: number; error: string }
  /** A poll came back. `polled` are the ids asked about; any missing from `statuses` no longer exist. */
  | { type: 'status'; polled: number[]; statuses: ReceiptProcessingStatus[] }
  /** A failed receipt was sent back for another attempt. */
  | { type: 'reprocess'; key: number }
  | { type: 'remove'; key: number }
  | { type: 'reset' }

function update(items: UploadItem[], key: number, patch: Partial<UploadItem>): UploadItem[] {
  return items.map(it => (it.key === key ? { ...it, ...patch } : it))
}

const WAITING = describeUploadEvent({ type: 'progress', stage: 'queued' })

function applyStatus(item: UploadItem, polled: Set<number>, byId: Map<number, ReceiptProcessingStatus>): UploadItem {
  if (item.phase !== 'processing' || item.receiptId == null || !polled.has(item.receiptId)) return item
  const st = byId.get(item.receiptId)
  if (!st) {
    return { ...item, phase: 'failed', error: 'This receipt was deleted', stageText: null }
  }
  if (st.status === 'processing') {
    if (!st.progress) return item
    const event = { type: 'progress' as const, ...st.progress }
    return {
      ...item,
      progress: uploadProgressReducer(item.progress, event),
      stageText: describeUploadEvent(event) ?? item.stageText,
    }
  }
  if (st.status === 'failed') {
    return { ...item, phase: 'failed', error: st.error ?? 'Could not read this receipt', stageText: null }
  }
  // Processed. Without a result there is nothing to hand to review yet — the
  // caller is expected to fill it in (see resultFromReceipt) before dispatching.
  if (!st.result) return item
  return { ...item, phase: 'ready', result: st.result, error: null, stageText: null }
}

export function uploadQueueReducer(items: UploadItem[], action: UploadQueueAction): UploadItem[] {
  switch (action.type) {
    case 'start': {
      const fresh: UploadItem = {
        key: action.key,
        name: action.name,
        phase: 'uploading',
        receiptId: null,
        progress: initialUploadProgress,
        stageText: null,
        error: null,
        result: null,
      }
      return items.some(it => it.key === action.key)
        ? items.map(it => (it.key === action.key ? fresh : it))
        : [...items, fresh]
    }
    case 'accepted':
      return update(items, action.key, {
        phase: 'processing',
        receiptId: action.receiptId,
        progress: uploadProgressReducer(initialUploadProgress, { type: 'progress', stage: 'queued' }),
        stageText: WAITING,
        error: null,
      })
    case 'upload-failed':
      return update(items, action.key, { phase: 'upload-failed', error: action.error })
    case 'status': {
      const polled = new Set(action.polled)
      const byId = new Map(action.statuses.map(s => [s.id, s]))
      return items.map(it => applyStatus(it, polled, byId))
    }
    case 'reprocess':
      return update(items, action.key, {
        phase: 'processing',
        progress: uploadProgressReducer(initialUploadProgress, { type: 'progress', stage: 'queued' }),
        stageText: WAITING,
        error: null,
        result: null,
      })
    case 'remove':
      return items.filter(it => it.key !== action.key)
    case 'reset':
      return []
  }
}

// ── Selectors ────────────────────────────────────────────────────────────────

/** Receipt ids whose progress still needs polling. */
export function pollIds(items: UploadItem[]): number[] {
  return items
    .filter(it => it.phase === 'processing' && it.receiptId != null)
    .map(it => it.receiptId!)
}

/** True while any file's bytes are still on their way to the server. */
export function isUploading(items: UploadItem[]): boolean {
  return items.some(it => it.phase === 'uploading')
}

/** True once nothing is in flight any more (every item is ready or has failed). */
export function isSettled(items: UploadItem[]): boolean {
  return items.length > 0 && items.every(it => it.phase !== 'uploading' && it.phase !== 'processing')
}

/** True when every receipt was read successfully — review can start on its own. */
export function allReady(items: UploadItem[]): boolean {
  return items.length > 0 && items.every(it => it.phase === 'ready')
}

/** Results of the receipts that are ready for review, in upload order. */
export function readyResults(items: UploadItem[]): ProcessingResult[] {
  return items.filter(it => it.phase === 'ready' && it.result).map(it => it.result!)
}

export function countPhase(items: UploadItem[], ...phases: UploadPhase[]): number {
  return items.filter(it => phases.includes(it.phase)).length
}
