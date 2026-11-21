import { describe, it, expect } from 'vitest'
import type { ProcessingResult, ReceiptProcessingStatus } from '../api/receipts'
import {
  allReady, countPhase, isSettled, isUploading, pollIds, readyResults, uploadQueueReducer,
} from './uploadQueue'
import type { UploadItem, UploadQueueAction } from './uploadQueue'

function result(id: number): ProcessingResult {
  return {
    receipt_id: id,
    store_name: `Store ${id}`,
    receipt_date: '2026-02-15',
    ocr_raw: null,
    subtotal: 10,
    tax: 1,
    discounts: 0,
    total: 11,
    total_verified: true,
    verification_message: 'ok',
    thumbnail_path: null,
    categorization_failed: false,
    items: [],
  }
}

const status = (id: number, over: Partial<ReceiptProcessingStatus>): ReceiptProcessingStatus => ({
  id, status: 'processing', progress: null, error: null, result: null, ...over,
})

function run(actions: UploadQueueAction[], from: UploadItem[] = []): UploadItem[] {
  return actions.reduce(uploadQueueReducer, from)
}

/** Two files: the first accepted as receipt 10, the second still uploading. */
const twoFiles = () => run([
  { type: 'start', key: 0, name: 'a.jpg' },
  { type: 'start', key: 1, name: 'b.jpg' },
  { type: 'accepted', key: 0, receiptId: 10 },
])

describe('uploadQueueReducer', () => {
  it('starts each file as uploading, in order', () => {
    const items = run([
      { type: 'start', key: 0, name: 'a.jpg' },
      { type: 'start', key: 1, name: 'b.jpg' },
    ])
    expect(items.map(i => [i.key, i.phase, i.receiptId])).toEqual([[0, 'uploading', null], [1, 'uploading', null]])
    expect(isUploading(items)).toBe(true)
    expect(pollIds(items)).toEqual([])
  })

  it('moves to processing once the server accepts the upload', () => {
    const items = twoFiles()
    expect(items[0]).toMatchObject({ phase: 'processing', receiptId: 10, stageText: 'Waiting to start' })
    expect(items[0].progress.step).toBe(1)          // past "Uploading image"
    expect(pollIds(items)).toEqual([10])
    expect(isUploading(items)).toBe(true)           // the other file is still on its way
  })

  it('records an upload that never reached the server, and restarts it on retry', () => {
    let items = run([{ type: 'upload-failed', key: 1, error: 'Upload failed: offline' }], twoFiles())
    expect(items[1]).toMatchObject({ phase: 'upload-failed', error: 'Upload failed: offline' })
    expect(isUploading(items)).toBe(false)

    items = run([{ type: 'start', key: 1, name: 'b.jpg' }], items)
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ phase: 'uploading', error: null })
  })

  it('follows polled progress', () => {
    let items = run([{
      type: 'status', polled: [10],
      statuses: [status(10, { progress: { stage: 'reading', method: 'ai', items: 7 } })],
    }], twoFiles())
    expect(items[0].stageText).toBe('Reading receipt with AI · 7 items found')
    expect(items[0].progress).toMatchObject({ step: 2, method: 'ai', items: 7 })

    items = run([{
      type: 'status', polled: [10],
      statuses: [status(10, { progress: { stage: 'rechecking', items: 8, problems: 1 } })],
    }], items)
    expect(items[0].progress).toMatchObject({ step: 3, rechecking: true })
    expect(items[0].stageText).toBe('Double-checking totals…')
  })

  it('keeps the last known stage when a poll carries an unknown one', () => {
    const before = run([{
      type: 'status', polled: [10], statuses: [status(10, { progress: { stage: 'checking' } })],
    }], twoFiles())
    const after = run([{
      type: 'status', polled: [10], statuses: [status(10, { progress: { stage: 'warp-drive' } })],
    }], before)
    expect(after[0].stageText).toBe('Checking totals')
    expect(after[0].progress.step).toBe(3)
  })

  it('becomes ready with the result when processing finishes', () => {
    const items = run([{
      type: 'status', polled: [10], statuses: [status(10, { status: 'pending', result: result(10) })],
    }], twoFiles())
    expect(items[0]).toMatchObject({ phase: 'ready', error: null })
    expect(items[0].result?.receipt_id).toBe(10)
    expect(pollIds(items)).toEqual([])
  })

  it('keeps polling a processed receipt until its result is supplied', () => {
    const items = run([{
      type: 'status', polled: [10], statuses: [status(10, { status: 'pending', result: null })],
    }], twoFiles())
    expect(items[0].phase).toBe('processing')
  })

  it('records a processing failure with the server reason', () => {
    const items = run([{
      type: 'status', polled: [10],
      statuses: [status(10, { status: 'failed', error: 'Failed to process PDF: bad xref' })],
    }], twoFiles())
    expect(items[0]).toMatchObject({ phase: 'failed', error: 'Failed to process PDF: bad xref' })
  })

  it('treats a polled receipt the server no longer has as deleted', () => {
    const items = run([{ type: 'status', polled: [10], statuses: [] }], twoFiles())
    expect(items[0]).toMatchObject({ phase: 'failed', error: 'This receipt was deleted' })
  })

  it('ignores statuses for receipts it did not ask about or that are already settled', () => {
    const ready = run([{
      type: 'status', polled: [10], statuses: [status(10, { status: 'pending', result: result(10) })],
    }], twoFiles())
    // A late poll response that still says "processing" must not un-finish it.
    const after = run([{
      type: 'status', polled: [10], statuses: [status(10, { progress: { stage: 'reading' } })],
    }], ready)
    expect(after[0].phase).toBe('ready')
    // Not in `polled` → not judged missing.
    const untouched = run([{ type: 'status', polled: [99], statuses: [] }], twoFiles())
    expect(untouched[0].phase).toBe('processing')
  })

  it('sends a failed receipt back to processing on retry', () => {
    const failed = run([{
      type: 'status', polled: [10], statuses: [status(10, { status: 'failed', error: 'nope' })],
    }], twoFiles())
    const items = run([{ type: 'reprocess', key: 0 }], failed)
    expect(items[0]).toMatchObject({ phase: 'processing', receiptId: 10, error: null })
    expect(pollIds(items)).toEqual([10])
  })

  it('removes and resets', () => {
    expect(run([{ type: 'remove', key: 0 }], twoFiles()).map(i => i.key)).toEqual([1])
    expect(run([{ type: 'reset' }], twoFiles())).toEqual([])
  })
})

describe('selectors', () => {
  const settle = (second: ReceiptProcessingStatus) => run([
    { type: 'accepted', key: 1, receiptId: 11 },
    {
      type: 'status', polled: [10, 11],
      statuses: [status(10, { status: 'pending', result: result(10) }), second],
    },
  ], twoFiles())

  it('is settled and all-ready when every receipt was read', () => {
    const items = settle(status(11, { status: 'pending', result: result(11) }))
    expect(isSettled(items)).toBe(true)
    expect(allReady(items)).toBe(true)
    expect(readyResults(items).map(r => r.receipt_id)).toEqual([10, 11])
  })

  it('is settled but not all-ready when one failed', () => {
    const items = settle(status(11, { status: 'failed', error: 'nope' }))
    expect(isSettled(items)).toBe(true)
    expect(allReady(items)).toBe(false)
    expect(readyResults(items).map(r => r.receipt_id)).toEqual([10])
    expect(countPhase(items, 'failed', 'upload-failed')).toBe(1)
  })

  it('is not settled while anything is in flight, or when empty', () => {
    expect(isSettled(twoFiles())).toBe(false)
    expect(isSettled(settle(status(11, { progress: { stage: 'reading' } })))).toBe(false)
    expect(isSettled([])).toBe(false)
    expect(allReady([])).toBe(false)
  })
})
