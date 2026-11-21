import { describe, it, expect } from 'vitest'
import {
  filterReceipts, adjacentIds, awaitsApproval, receiptDisplayName, receiptStatusNote, statusVariant,
} from './receiptFilter'
import type { ReceiptSummary } from '../types'

function r(id: number, over: Partial<ReceiptSummary> = {}): ReceiptSummary {
  return {
    id,
    store_name: `Store ${id}`,
    receipt_date: '2026-02-10',
    scanned_at: '2026-02-10T00:00:00Z',
    status: 'pending',
    total: 10,
    item_count: 1,
    ...over,
  }
}

describe('filterReceipts', () => {
  const list = [
    r(1, { store_name: 'Whole Foods', status: 'verified', receipt_date: '2026-02-20' }),
    r(2, { store_name: 'Costco', status: 'pending', receipt_date: '2026-02-15' }),
    r(3, { store_name: 'Safeway', status: 'review', receipt_date: '2026-01-28' }),
  ]

  it('returns all with the empty filter', () => {
    expect(filterReceipts(list, { search: '', status: 'All' })).toHaveLength(3)
  })

  it('filters Approved to verified only', () => {
    const out = filterReceipts(list, { search: '', status: 'Approved' })
    expect(out.map(x => x.id)).toEqual([1])
  })

  it('filters Pending to everything not verified', () => {
    const out = filterReceipts(list, { search: '', status: 'Pending' })
    expect(out.map(x => x.id)).toEqual([2, 3])
  })

  it('matches search against store name (case-insensitive) and date', () => {
    expect(filterReceipts(list, { search: 'cost', status: 'All' }).map(x => x.id)).toEqual([2])
    expect(filterReceipts(list, { search: '2026-01', status: 'All' }).map(x => x.id)).toEqual([3])
  })

  it('combines search and status', () => {
    expect(filterReceipts(list, { search: 'Foods', status: 'Pending' })).toHaveLength(0)
    expect(filterReceipts(list, { search: 'Foods', status: 'Approved' }).map(x => x.id)).toEqual([1])
  })
})

describe('adjacentIds', () => {
  const list = [r(10), r(20), r(30)]

  it('gives prev/next for a middle item', () => {
    expect(adjacentIds(list, 20)).toEqual({ prevId: 10, nextId: 30, index: 1, total: 3 })
  })

  it('has no prev at the start', () => {
    expect(adjacentIds(list, 10)).toEqual({ prevId: null, nextId: 20, index: 0, total: 3 })
  })

  it('has no next at the end', () => {
    expect(adjacentIds(list, 30)).toEqual({ prevId: 20, nextId: null, index: 2, total: 3 })
  })

  it('returns index -1 when the id is absent', () => {
    expect(adjacentIds(list, 999)).toEqual({ prevId: null, nextId: null, index: -1, total: 3 })
  })
})

describe('receipts that are still processing or failed', () => {
  const processing = r(7, { status: 'processing', store_name: 'Unknown Store', total: null, item_count: 0 })
  const failed = r(8, { status: 'failed', store_name: null, total: null, item_count: 0 })

  it('are listed under All and Pending, not Approved', () => {
    const list = [r(1, { status: 'verified' }), processing, failed]
    expect(filterReceipts(list, { search: '', status: 'All' })).toHaveLength(3)
    expect(filterReceipts(list, { search: '', status: 'Pending' }).map(x => x.id)).toEqual([7, 8])
    expect(filterReceipts(list, { search: '', status: 'Approved' }).map(x => x.id)).toEqual([1])
  })

  it('do not count as awaiting approval', () => {
    expect(awaitsApproval(processing)).toBe(false)
    expect(awaitsApproval(failed)).toBe(false)
    expect(awaitsApproval(r(1, { status: 'pending' }))).toBe(true)
    expect(awaitsApproval(r(1, { status: 'review' }))).toBe(true)
    expect(awaitsApproval(r(1, { status: 'verified' }))).toBe(false)
  })

  it('get a placeholder name instead of "Unknown Store"', () => {
    expect(receiptDisplayName(processing)).toBe('New receipt')
    expect(receiptDisplayName(failed)).toBe('New receipt')
    // A store-name hint given at upload is kept.
    expect(receiptDisplayName(r(9, { status: 'processing', store_name: 'Costco' }))).toBe('Costco')
    // Processed receipts are unchanged.
    expect(receiptDisplayName(r(1, { store_name: 'Unknown Store' }))).toBe('Unknown Store')
    expect(receiptDisplayName(r(1, { store_name: null }), 'Unknown')).toBe('Unknown')
  })

  it('get a note in place of the item count', () => {
    expect(receiptStatusNote(processing)).toBe('being read…')
    expect(receiptStatusNote(failed)).toBe('could not be read')
    expect(receiptStatusNote(r(1))).toBeNull()
  })

  it('map to their own badge, with unknown statuses reading as pending', () => {
    expect(statusVariant('processing')).toBe('processing')
    expect(statusVariant('failed')).toBe('failed')
    expect(statusVariant('verified')).toBe('verified')
    expect(statusVariant('something-new')).toBe('pending')
    expect(statusVariant(null)).toBe('pending')
  })
})
