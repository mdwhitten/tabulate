import type { UploadProgressEvent } from '../api/receipts'

/**
 * Maps streamed upload progress events (from POST /receipts/upload-stream)
 * onto the step list shown in the upload modal.
 *
 * Steps:
 *   0 Uploading image        — until the first server event arrives
 *   1 Preparing image        — `preparing`
 *   2 Reading receipt        — `reading` (AI or OCR fallback), live item count
 *   3 Checking totals        — `checking`, or `rechecking` (Claude re-reads)
 *   4 Categorizing & saving  — `categorizing`, `saving`
 */
export const UPLOAD_STEP_COUNT = 5

export interface UploadProgressState {
  /** Index of the active step (steps before it are done). */
  step: number
  /** How the receipt is being read: Claude Vision or Tesseract fallback. */
  method: 'ai' | 'ocr'
  /** Items found so far while reading, if reported. */
  items: number | null
  /** True while Claude is double-checking a receipt whose totals didn't reconcile. */
  rechecking: boolean
}

export const initialUploadProgress: UploadProgressState = {
  step: 0,
  method: 'ai',
  items: null,
  rechecking: false,
}

const STAGE_STEP = new Map<string, number>([
  ['preparing', 1],
  ['reading', 2],
  ['rechecking', 3],
  ['checking', 3],
  ['categorizing', 4],
  ['saving', 4],
])

export type UploadProgressAction = UploadProgressEvent | { type: 'reset' }

export function uploadProgressReducer(
  state: UploadProgressState,
  event: UploadProgressAction,
): UploadProgressState {
  if (event.type === 'reset') return initialUploadProgress
  if (event.type !== 'progress') return state

  const target = STAGE_STEP.get(event.stage)
  if (target === undefined) return state   // unknown stage — ignore

  const items = typeof event.items === 'number' ? event.items : state.items

  // AI unavailable → Tesseract fallback restarts the reading step; the item
  // count from the abandoned AI pass no longer applies.
  if (event.stage === 'reading' && event.method === 'ocr' && state.method !== 'ocr') {
    return {
      step: 2,
      method: 'ocr',
      items: typeof event.items === 'number' ? event.items : null,
      rechecking: false,
    }
  }

  const method = event.method === 'ai' || event.method === 'ocr' ? event.method : state.method
  // Steps only move forward (a re-read during rechecking keeps "Checking totals" active).
  const step = Math.max(state.step, target)
  const rechecking =
    event.stage === 'rechecking' ? true
    : event.stage === 'reading' ? state.rechecking
    : false

  return { step, method, items, rechecking }
}

export interface UploadStepView {
  label: string
  detail?: string
}

function itemsText(n: number): string {
  return `${n} item${n === 1 ? '' : 's'} found`
}

/** Labels (and optional sub-labels) for each step given the current state. */
export function uploadStepViews(state: UploadProgressState): UploadStepView[] {
  return [
    { label: 'Uploading image' },
    { label: 'Preparing image' },
    {
      label: state.method === 'ocr' ? 'Reading receipt (OCR)' : 'Reading receipt with AI',
      detail: state.items != null ? itemsText(state.items) : undefined,
    },
    { label: state.rechecking ? 'Double-checking totals…' : 'Checking totals' },
    { label: 'Categorizing & saving' },
  ]
}

/**
 * One-line description of a single progress event, for compact displays
 * (e.g. batch uploads). Returns null for unknown stages.
 */
export function describeUploadEvent(event: UploadProgressEvent): string | null {
  switch (event.stage) {
    case 'preparing':
      return 'Preparing image'
    case 'reading': {
      const base = event.method === 'ocr' ? 'Reading receipt (OCR)' : 'Reading receipt with AI'
      return typeof event.items === 'number' ? `${base} · ${itemsText(event.items)}` : base
    }
    case 'rechecking':
      return 'Double-checking totals…'
    case 'checking':
      return 'Checking totals'
    case 'categorizing':
      return 'Categorizing items'
    case 'saving':
      return 'Saving'
    default:
      return null
  }
}
