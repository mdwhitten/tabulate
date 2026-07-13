import { describe, it, expect } from 'vitest'
import { jscanifyToCropCorners, cropCornersToJscanify, outputSize } from './scanner'
import type { CropCorners } from '../api/receipts'

describe('jscanifyToCropCorners', () => {
  it('maps jscanify corners to fractional CropCorners in TL,TR,BR,BL order', () => {
    const result = jscanifyToCropCorners(
      {
        topLeftCorner:     { x: 0,   y: 0 },
        topRightCorner:    { x: 100, y: 0 },
        bottomRightCorner: { x: 100, y: 200 },
        bottomLeftCorner:  { x: 0,   y: 200 },
      },
      100, 200,
    )
    expect(result).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]])
  })
  it('returns null when a corner is missing', () => {
    expect(jscanifyToCropCorners({ topLeftCorner: { x: 0, y: 0 } }, 100, 100)).toBeNull()
  })
  it('returns null when the image has no area', () => {
    const full = {
      topLeftCorner: { x: 0, y: 0 }, topRightCorner: { x: 1, y: 0 },
      bottomRightCorner: { x: 1, y: 1 }, bottomLeftCorner: { x: 0, y: 1 },
    }
    expect(jscanifyToCropCorners(full, 0, 100)).toBeNull()
  })
})

describe('cropCornersToJscanify', () => {
  it('maps fractional CropCorners back to jscanify pixel corners', () => {
    const c: CropCorners = [[0, 0], [1, 0], [1, 1], [0, 1]]
    expect(cropCornersToJscanify(c, 100, 200)).toEqual({
      topLeftCorner:     { x: 0,   y: 0 },
      topRightCorner:    { x: 100, y: 0 },
      bottomRightCorner: { x: 100, y: 200 },
      bottomLeftCorner:  { x: 0,   y: 200 },
    })
  })
  it('round-trips with jscanifyToCropCorners', () => {
    const c: CropCorners = [[0.1, 0.2], [0.9, 0.15], [0.85, 0.95], [0.12, 0.9]]
    const back = jscanifyToCropCorners(cropCornersToJscanify(c, 400, 600), 400, 600)
    expect(back).not.toBeNull()
    back!.forEach((pt, i) => {
      expect(pt[0]).toBeCloseTo(c[i][0], 6)
      expect(pt[1]).toBeCloseTo(c[i][1], 6)
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
