import { describe, it, expect } from 'vitest'
import { cropCornersToJscanify, outputSize, plausibleQuad } from './scanner'
import type { CropCorners } from '../api/receipts'

describe('plausibleQuad', () => {
  it('accepts a normal receipt-sized quad', () => {
    expect(plausibleQuad([[0.1, 0.05], [0.85, 0.08], [0.88, 0.92], [0.12, 0.95]])).toBe(true)
  })
  it('rejects a quad that fills essentially the whole frame (grabbed the table)', () => {
    expect(plausibleQuad([[0, 0], [1, 0], [1, 1], [0, 1]])).toBe(false)
  })
  it('rejects a tiny speck', () => {
    expect(plausibleQuad([[0.4, 0.4], [0.45, 0.4], [0.45, 0.45], [0.4, 0.45]])).toBe(false)
  })
  it('accepts a small receipt shot from a distance', () => {
    expect(plausibleQuad([[0.4, 0.3], [0.62, 0.3], [0.62, 0.65], [0.4, 0.65]])).toBe(true)
  })
})

describe('cropCornersToJscanify', () => {
  it('maps fractional CropCorners to jscanify pixel corners', () => {
    const c: CropCorners = [[0, 0], [1, 0], [1, 1], [0, 1]]
    expect(cropCornersToJscanify(c, 100, 200)).toEqual({
      topLeftCorner:     { x: 0,   y: 0 },
      topRightCorner:    { x: 100, y: 0 },
      bottomRightCorner: { x: 100, y: 200 },
      bottomLeftCorner:  { x: 0,   y: 200 },
    })
  })
})

describe('outputSize', () => {
  it('uses the longest of each pair of opposing edges', () => {
    // A trapezoid: top edge 80px, bottom edge 100px, sides 200px.
    const c: CropCorners = [[0.1, 0], [0.9, 0], [1, 1], [0, 1]]
    const { w, h } = outputSize(c, 100, 200)
    expect(w).toBe(100)  // max(top=80, bottom=100)
    expect(h).toBe(200)
  })
  it('never returns a zero dimension', () => {
    const c: CropCorners = [[0, 0], [0, 0], [0, 0], [0, 0]]
    const { w, h } = outputSize(c, 100, 100)
    expect(w).toBeGreaterThanOrEqual(1)
    expect(h).toBeGreaterThanOrEqual(1)
  })
})
