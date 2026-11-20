import { describe, it, expect } from 'vitest'
import type { UploadProgressEvent } from '../api/receipts'
import {
  describeUploadEvent,
  initialUploadProgress,
  uploadProgressReducer,
  uploadStepViews,
  UPLOAD_STEP_COUNT,
} from './uploadProgress'
import type { UploadProgressState } from './uploadProgress'

const ev = (stage: string, extra: Partial<UploadProgressEvent> = {}): UploadProgressEvent => ({
  type: 'progress',
  stage,
  ...extra,
})

function run(events: UploadProgressEvent[], from: UploadProgressState = initialUploadProgress) {
  return events.reduce(uploadProgressReducer, from)
}

describe('uploadProgressReducer', () => {
  it('starts on "Uploading image" until the first event', () => {
    expect(initialUploadProgress.step).toBe(0)
    expect(uploadStepViews(initialUploadProgress)[0].label).toBe('Uploading image')
    expect(uploadStepViews(initialUploadProgress)).toHaveLength(UPLOAD_STEP_COUNT)
  })

  it('advances through the stages in order', () => {
    const events = [
      ev('preparing'),
      ev('reading', { method: 'ai' }),
      ev('checking'),
      ev('categorizing'),
      ev('saving'),
    ]
    const steps = events.map((_, i) => run(events.slice(0, i + 1)).step)
    expect(steps).toEqual([1, 2, 3, 4, 4])
  })

  it('jumps ahead when intermediate stages are skipped', () => {
    expect(run([ev('categorizing')]).step).toBe(4)
  })

  it('never moves backwards', () => {
    expect(run([ev('checking'), ev('preparing')]).step).toBe(3)
  })

  it('tracks the live AI item count', () => {
    const s = run([
      ev('preparing'),
      ev('reading', { method: 'ai' }),
      ev('reading', { method: 'ai', items: 3 }),
      ev('reading', { method: 'ai', items: 23 }),
    ])
    expect(s).toMatchObject({ step: 2, method: 'ai', items: 23 })
    expect(uploadStepViews(s)[2]).toEqual({ label: 'Reading receipt with AI', detail: '23 items found' })
  })

  it('keeps the item count on later stages', () => {
    const s = run([ev('reading', { method: 'ai', items: 1 }), ev('checking')])
    expect(s.items).toBe(1)
    expect(uploadStepViews(s)[2].detail).toBe('1 item found')
  })

  it('labels the OCR fallback and drops the AI item count', () => {
    const s = run([
      ev('preparing'),
      ev('reading', { method: 'ai', items: 4 }),
      ev('reading', { method: 'ocr' }),
    ])
    expect(s).toMatchObject({ step: 2, method: 'ocr', items: null })
    expect(uploadStepViews(s)[2]).toEqual({ label: 'Reading receipt (OCR)', detail: undefined })
  })

  it('returns to the reading step if the OCR fallback starts after a recheck', () => {
    const s = run([ev('reading', { method: 'ai', items: 9 }), ev('rechecking', { problems: 2 }), ev('reading', { method: 'ocr' })])
    expect(s).toMatchObject({ step: 2, method: 'ocr', rechecking: false })
  })

  it('shows "Double-checking totals…" while rechecking, then "Checking totals"', () => {
    const rechecking = run([ev('reading', { method: 'ai', items: 5 }), ev('rechecking', { problems: 2 })])
    expect(rechecking).toMatchObject({ step: 3, rechecking: true })
    expect(uploadStepViews(rechecking)[3].label).toBe('Double-checking totals…')

    // Claude may stream items again while re-reading: count updates, step holds.
    const reread = run([ev('reading', { method: 'ai', items: 6 })], rechecking)
    expect(reread).toMatchObject({ step: 3, rechecking: true, items: 6 })

    const checked = run([ev('checking')], reread)
    expect(checked).toMatchObject({ step: 3, rechecking: false })
    expect(uploadStepViews(checked)[3].label).toBe('Checking totals')
  })

  it('ignores unknown stages and event types', () => {
    const s = run([ev('preparing')])
    expect(run([ev('teleporting')], s)).toBe(s)
    expect(run([ev('toString')], s)).toBe(s)
    expect(uploadProgressReducer(s, { type: 'mystery' } as unknown as UploadProgressEvent)).toBe(s)
  })

  it('ignores unknown fields', () => {
    const s = run([ev('reading', { method: 'ai', extra: true } as Partial<UploadProgressEvent>)])
    expect(s).toEqual({ step: 2, method: 'ai', items: null, rechecking: false })
  })

  it('resets', () => {
    const s = run([ev('saving')])
    expect(uploadProgressReducer(s, { type: 'reset' })).toEqual(initialUploadProgress)
  })
})

describe('describeUploadEvent', () => {
  it('describes known stages', () => {
    expect(describeUploadEvent(ev('preparing'))).toBe('Preparing image')
    expect(describeUploadEvent(ev('reading', { method: 'ai' }))).toBe('Reading receipt with AI')
    expect(describeUploadEvent(ev('reading', { method: 'ai', items: 7 }))).toBe('Reading receipt with AI · 7 items found')
    expect(describeUploadEvent(ev('reading', { method: 'ocr' }))).toBe('Reading receipt (OCR)')
    expect(describeUploadEvent(ev('rechecking', { problems: 1 }))).toBe('Double-checking totals…')
    expect(describeUploadEvent(ev('checking'))).toBe('Checking totals')
    expect(describeUploadEvent(ev('categorizing'))).toBe('Categorizing items')
    expect(describeUploadEvent(ev('saving'))).toBe('Saving')
  })

  it('returns null for unknown stages', () => {
    expect(describeUploadEvent(ev('warp-drive'))).toBeNull()
  })
})
