import { describe, it, expect } from 'vitest'
import { filterReceipts, adjacentIds } from './receiptFilter'
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
