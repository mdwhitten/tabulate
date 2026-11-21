import { describe, it, expect } from 'vitest'
import {
  type Planes, type Pt, type Quad,
  isConvexQuad, minInteriorAngle, orderQuad, paperness, pointInQuad, polygonArea,
  reduceToQuad, refineQuad, scoreQuad, sideSupport,
} from './quadGeometry'

const pt = (x: number, y: number): Pt => ({ x, y })

/** Synthetic planes: `bg` everywhere, `fg` inside the axis-aligned rect. */
function planes(
  w: number, h: number, rect: [number, number, number, number], fg = 230, bg = 60,
): Planes {
  const data = new Uint8Array(w * h).fill(bg)
  const [x0, y0, x1, y1] = rect
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[y * w + x] = fg
  return { w, h, channels: [data], white: data, whiteRef: Math.max(fg, bg) }
}

const rectQuad = (x0: number, y0: number, x1: number, y1: number): Quad =>
  [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]

describe('reduceToQuad', () => {
  it('returns a quad unchanged', () => {
    const q = rectQuad(0, 0, 10, 20)
    expect(reduceToQuad(q)).toEqual(q)
  })

  it('restores a clipped corner instead of cutting across it', () => {
    // A 100×200 rectangle with its top-right corner torn off.
    const hull = [pt(0, 0), pt(90, 0), pt(100, 10), pt(100, 200), pt(0, 200)]
    const q = reduceToQuad(hull)!
    expect(q).toHaveLength(4)
    expect(polygonArea(q)).toBeCloseTo(100 * 200, 6)
    expect(q.some(p => Math.abs(p.x - 100) < 1e-6 && Math.abs(p.y) < 1e-6)).toBe(true)
  })

  it('ignores extra collinear points', () => {
    const hull = [pt(0, 0), pt(50, 0), pt(100, 0), pt(100, 100), pt(40, 100), pt(0, 100)]
    const q = reduceToQuad(hull)!
    expect(polygonArea(q)).toBeCloseTo(100 * 100, 6)
  })

  it('returns null for fewer than 4 points', () => {
    expect(reduceToQuad([pt(0, 0), pt(1, 0), pt(0, 1)])).toBeNull()
  })
})

describe('orderQuad', () => {
  it('orders TL, TR, BR, BL from shuffled input', () => {
    const q = orderQuad([pt(100, 200), pt(0, 0), pt(0, 200), pt(100, 0)])
    expect(q).toEqual([pt(0, 0), pt(100, 0), pt(100, 200), pt(0, 200)])
  })

  it('keeps four distinct corners for a 45° diamond', () => {
    const q = orderQuad([pt(50, 0), pt(100, 50), pt(50, 100), pt(0, 50)])
    expect(new Set(q.map(p => `${p.x},${p.y}`)).size).toBe(4)
    expect(isConvexQuad(q)).toBe(true)
  })
})

describe('quad predicates', () => {
  it('isConvexQuad rejects a bow-tie and a dart', () => {
    expect(isConvexQuad(rectQuad(0, 0, 10, 10))).toBe(true)
    expect(isConvexQuad([pt(0, 0), pt(10, 10), pt(10, 0), pt(0, 10)])).toBe(false)
    expect(isConvexQuad([pt(0, 0), pt(10, 0), pt(2, 2), pt(0, 10)])).toBe(false)
  })

  it('minInteriorAngle is 90° for a rectangle and small for a sliver', () => {
    expect(minInteriorAngle(rectQuad(0, 0, 30, 10))).toBeCloseTo(90, 6)
    expect(minInteriorAngle([pt(0, 0), pt(100, 0), pt(200, 10), pt(100, 10)])).toBeLessThan(10)
  })

  it('pointInQuad honours the tolerance', () => {
    const q = rectQuad(10, 10, 50, 50)
    expect(pointInQuad(pt(30, 30), q)).toBe(true)
    expect(pointInQuad(pt(8, 30), q)).toBe(false)
    expect(pointInQuad(pt(8, 30), q, 3)).toBe(true)
  })
})

describe('sideSupport', () => {
  const pl = planes(200, 200, [50, 40, 150, 160])
  const centre = pt(100, 100)

  it('gives full "bright" support to a side on the paper edge', () => {
    const s = sideSupport(pl, pt(50, 40), pt(150, 40), centre)
    expect(s).toEqual({ bright: 1, dark: 0, border: false })
  })

  it('gives no support to a side crossing flat paper', () => {
    const s = sideSupport(pl, pt(50, 100), pt(150, 100), pt(100, 130))
    expect(s.bright + s.dark).toBe(0)
  })

  it('flags a side lying on the image border', () => {
    expect(sideSupport(pl, pt(0, 0), pt(199, 0), centre).border).toBe(true)
  })
})

describe('scoreQuad', () => {
  const pl = planes(200, 200, [50, 40, 150, 160])

  it('scores the true paper outline highly', () => {
    expect(scoreQuad(pl, rectQuad(50, 40, 150, 160), 1)).toBeGreaterThan(0.8)
  })

  it('scores a shifted quad much lower', () => {
    const good = scoreQuad(pl, rectQuad(50, 40, 150, 160), 1)
    const shifted = scoreQuad(pl, rectQuad(80, 70, 180, 190), 1)
    expect(shifted).toBeLessThan(good * 0.5)
  })

  it('still accepts paper that is darker than its background', () => {
    const inverted = planes(200, 200, [50, 40, 150, 160], 170, 235)
    expect(scoreQuad(inverted, rectQuad(50, 40, 150, 160), 1)).toBeGreaterThan(0.5)
  })

  it('accepts a long receipt running off the top and bottom of the frame', () => {
    const long = planes(200, 200, [60, 0, 140, 199])
    expect(scoreQuad(long, rectQuad(60, 0, 140, 199), 1)).toBeGreaterThan(0.6)
  })

  it('rejects the whole frame, specks and poorly filled quads', () => {
    expect(scoreQuad(pl, rectQuad(0, 0, 199, 199), 1)).toBe(0)
    expect(scoreQuad(pl, rectQuad(90, 90, 100, 100), 1)).toBe(0)
    expect(scoreQuad(pl, rectQuad(50, 40, 150, 160), 0.5)).toBe(0)
  })

  it('prefers white paper over an equally crisp dark object', () => {
    // Bright paper on the left, a black phone on the right, mid-gray table.
    const w = 300, h = 200
    const data = new Uint8Array(w * h).fill(120)
    for (let y = 40; y <= 160; y++) {
      for (let x = 30; x <= 130; x++) data[y * w + x] = 235
      for (let x = 170; x <= 270; x++) data[y * w + x] = 15
    }
    const both: Planes = { w, h, channels: [data], white: data, whiteRef: 235 }
    const paper = scoreQuad(both, rectQuad(30, 40, 130, 160), 1)
    const phone = scoreQuad(both, rectQuad(170, 40, 270, 160), 1)
    expect(paper).toBeGreaterThan(phone)
  })
})

describe('paperness', () => {
  it('is ~1 inside white paper and low on a dark surface', () => {
    const pl = planes(200, 200, [50, 40, 150, 160])
    expect(paperness(pl, rectQuad(55, 45, 145, 155))).toBeCloseTo(1, 2)
    expect(paperness(pl, rectQuad(0, 0, 40, 30))).toBeLessThan(0.3)
  })
})

describe('refineQuad', () => {
  it('snaps a loose quad onto the paper edge', () => {
    const pl = planes(200, 200, [50, 40, 150, 160])
    const refined = refineQuad(pl, rectQuad(45, 36, 155, 165))
    const truth = rectQuad(50, 40, 150, 160)
    refined.forEach((p, i) => {
      expect(Math.abs(p.x - truth[i].x)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(p.y - truth[i].y)).toBeLessThanOrEqual(1.5)
    })
  })

  it('leaves the quad alone when there is no edge nearby', () => {
    const flat = planes(200, 200, [0, 0, 199, 199])
    const q = rectQuad(40, 40, 160, 160)
    expect(refineQuad(flat, q)).toEqual(q)
  })
})
