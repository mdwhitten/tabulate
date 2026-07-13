import { describe, it, expect } from 'vitest'
import { advanceBatch, isBatchActive, batchPosition } from './batch'

describe('advanceBatch', () => {
  it('advances to the next index within the queue', () => {
    expect(advanceBatch(3, 0)).toEqual({ index: 1, done: false })
    expect(advanceBatch(3, 1)).toEqual({ index: 2, done: false })
  })
  it('reports done and holds the index at the end of the queue', () => {
    expect(advanceBatch(3, 2)).toEqual({ index: 2, done: true })
  })
  it('is immediately done for a single-item batch', () => {
    expect(advanceBatch(1, 0)).toEqual({ index: 0, done: true })
  })
})

describe('isBatchActive', () => {
  it('is inactive for a single upload', () => {
    expect(isBatchActive(1)).toBe(false)
    expect(isBatchActive(0)).toBe(false)
  })
  it('is active for multiple receipts', () => {
    expect(isBatchActive(2)).toBe(true)
  })
})

describe('batchPosition', () => {
  it('returns null when not a batch', () => {
    expect(batchPosition(1, 0)).toBeNull()
  })
  it('returns 1-based position within a batch', () => {
    expect(batchPosition(4, 0)).toEqual({ current: 1, total: 4 })
    expect(batchPosition(4, 3)).toEqual({ current: 4, total: 4 })
  })
  it('returns null for out-of-range indices', () => {
    expect(batchPosition(4, 4)).toBeNull()
    expect(batchPosition(4, -1)).toBeNull()
  })
})
