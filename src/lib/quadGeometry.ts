/**
 * Pure geometry + scoring helpers for the receipt quad detector (see
 * ./quadDetect). No OpenCV / DOM — everything here is unit-tested.
 *
 * All points are in pixel coordinates of the (small) detection image.
 */

export interface Pt { x: number; y: number }
export type Quad = [Pt, Pt, Pt, Pt]

/** Single-channel 8-bit images of the same size, row-major. */
export interface Planes {
  w: number
  h: number
  /** One or more channels to measure brightness steps on (e.g. gray, whiteness). */
  channels: Uint8Array[]
  /** "Whiteness" channel (min of R,G,B) and its bright reference level (e.g. 90th percentile). */
  white: Uint8Array
  whiteRef: number
}

/** Signed shoelace area (positive when the points run clockwise on screen, y down). */
export function signedArea(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i].x * q.y - q.x * p[i].y
  }
  return a / 2
}

export function polygonArea(p: Pt[]): number {
  return Math.abs(signedArea(p))
}

/**
 * Intersection of the infinite lines a1→a2 and b1→b2, with the parameters of
 * the hit along each (`t` on a, `u` on b). Null when (near-)parallel.
 */
export function intersectLines(a1: Pt, a2: Pt, b1: Pt, b2: Pt): { p: Pt; t: number; u: number } | null {
  const dax = a2.x - a1.x, day = a2.y - a1.y
  const dbx = b2.x - b1.x, dby = b2.y - b1.y
  const den = dax * dby - day * dbx
  if (Math.abs(den) < 1e-9) return null
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den
  const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / den
  return { p: { x: a1.x + t * dax, y: a1.y + t * day }, t, u }
}

/**
 * Reduce a convex polygon to the smallest-growth enclosing quadrilateral:
 * repeatedly drop the edge whose removal (extending its two neighbours until
 * they meet) adds the least area. Unlike `approxPolyDP` this never cuts corners
 * off, so torn / rounded / frame-clipped corners still produce the true paper
 * outline. Returns null if the polygon can't be reduced (fewer than 4 points,
 * or the neighbours of every edge diverge).
 */
export function reduceToQuad(hull: Pt[]): Quad | null {
  const p = hull.slice()
  if (p.length < 4) return null
  while (p.length > 4) {
    const n = p.length
    let bestI = -1
    let bestArea = Infinity
    let bestP: Pt | null = null
    for (let i = 0; i < n; i++) {
      const prev = p[(i - 1 + n) % n], a = p[i], b = p[(i + 1) % n], next = p[(i + 2) % n]
      const hit = intersectLines(prev, a, next, b)
      // The meeting point must lie beyond `a` (from prev) and beyond `b` (from next).
      if (!hit || hit.t < 1 - 1e-6 || hit.u < 1 - 1e-6) continue
      const added = polygonArea([a, hit.p, b])
      if (added < bestArea) { bestArea = added; bestI = i; bestP = hit.p }
    }
    if (bestI < 0 || !bestP) return null
    const j = (bestI + 1) % n
    p[bestI] = bestP
    p.splice(j, 1)
  }
  return p as Quad
}

/** True if the 4 points (in order) form a convex, non-degenerate quad. */
export function isConvexQuad(q: Pt[]): boolean {
  if (q.length !== 4) return false
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-6) return false
    const s = cross > 0 ? 1 : -1
    if (sign && s !== sign) return false
    sign = s
  }
  return true
}

/**
 * Order 4 points TL, TR, BR, BL. Sorts by angle around the centroid (so it
 * stays correct for strongly rotated quads, where the usual x+y / x−y trick
 * picks the same point twice) and starts from the point nearest the top-left.
 */
export function orderQuad(pts: Pt[]): Quad {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  ) // clockwise on screen (y down)
  let start = 0
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i
  }
  return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]) as Quad
}

/** True if `p` lies inside the convex quad, or within `tol` px outside it. */
export function pointInQuad(p: Pt, q: Pt[], tol = 0): boolean {
  const sign = signedArea(q) >= 0 ? 1 : -1
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const d = (sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))) / len
    if (d < -tol) return false
  }
  return true
}

/** Smallest interior angle of the quad, in degrees. */
export function minInteriorAngle(q: Pt[]): number {
  let min = 180
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4]
    const ax = p.x - c.x, ay = p.y - c.y, bx = n.x - c.x, by = n.y - c.y
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
    min = Math.min(min, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI)
  }
  return min
}

function sample(pl: Planes, ch: Uint8Array, x: number, y: number): number {
  const xi = Math.max(0, Math.min(pl.w - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(pl.h - 1, Math.round(y)))
  return ch[yi * pl.w + xi]
}

function inside(pl: Planes, x: number, y: number, margin = 0): boolean {
  return x >= margin && y >= margin && x <= pl.w - 1 - margin && y <= pl.h - 1 - margin
}

/** Unit normal of side a→b pointing towards `c` (the quad's centroid). */
function inwardNormal(a: Pt, b: Pt, c: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  let nx = -dy / len, ny = dx / len
  if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) { nx = -nx; ny = -ny }
  return { x: nx, y: ny }
}

function centroid(q: Pt[]): Pt {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 }
}

export interface SideSupport {
  /** 0–1: share of the side sitting on a step where the inside is brighter. */
  bright: number
  /** 0–1: share of the side sitting on a step where the inside is darker. */
  dark: number
  /** True when the side runs along / beyond the image border (the paper leaves the frame). */
  border: boolean
}

export const STEP_MIN = 10   // min brightness step (0–255) to count as a paper edge
const SAMPLES = 24
const REACH = 5              // px either side of the line to compare

/**
 * How well one side of a candidate quad is backed by the image: sample points
 * along it and compare brightness just inside vs just outside.
 */
export function sideSupport(pl: Planes, a: Pt, b: Pt, centre: Pt): SideSupport {
  const n = inwardNormal(a, b, centre)
  let bright = 0, dark = 0, valid = 0, border = 0
  for (let i = 0; i < SAMPLES; i++) {
    const t = 0.1 + (0.8 * i) / (SAMPLES - 1)
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
    const ox = x - n.x * REACH, oy = y - n.y * REACH
    if (!inside(pl, ox, oy, 1)) { border++; continue }
    valid++
    let up = false, down = false
    for (const ch of pl.channels) {
      const step = sample(pl, ch, x + n.x * REACH, y + n.y * REACH) - sample(pl, ch, ox, oy)
      if (step >= STEP_MIN) up = true
      else if (step <= -STEP_MIN) down = true
    }
    if (up) bright++
    else if (down) dark++
  }
  if (border > SAMPLES / 2) return { bright: 0, dark: 0, border: true }
  return { bright: valid ? bright / valid : 0, dark: valid ? dark / valid : 0, border: false }
}

/** Blend of the average and the weakest side, so one unsupported side sinks the quad. */
function combine(values: number[]): number {
  const mean = values.reduce((a, v) => a + v, 0) / values.length
  return 0.6 * mean + 0.4 * Math.min(...values)
}

/**
 * Score a candidate quad 0–1. `fill` is how much of the quad the segmented
 * region it came from actually covers (region area / quad area).
 * Returns 0 for quads that can't be a receipt.
 *
 * Paper is normally brighter than what it lies on, so a quad whose sides are
 * all "inside brighter" scores best; consistently "inside darker" (off-white
 * receipt on a white counter) is nearly as good; a mix of the two is weakest.
 */
export function scoreQuad(pl: Planes, q: Quad, fill: number): number {
  if (!isConvexQuad(q) || minInteriorAngle(q) < 45) return 0
  const areaFrac = polygonArea(q) / (pl.w * pl.h)
  if (areaFrac < 0.04 || areaFrac > 0.985) return 0
  const c = centroid(q)
  const sides: SideSupport[] = []
  for (let i = 0; i < 4; i++) {
    const s = sideSupport(pl, q[i], q[(i + 1) % 4], c)
    if (!s.border) sides.push(s)
  }
  if (sides.length < 2) return 0   // 3+ sides on the frame: that's just the photo itself
  const support = Math.max(
    combine(sides.map(s => s.bright)),
    0.85 * combine(sides.map(s => s.dark)),
    0.7 * combine(sides.map(s => s.bright + s.dark)),
  )
  const fillFactor = Math.max(0, Math.min(1, (fill - 0.6) / 0.3))
  const sizeFactor = 0.8 + 0.2 * Math.min(1, areaFrac / 0.3)
  const paperFactor = 0.5 + 0.5 * paperness(pl, q)
  return support * fillFactor * sizeFactor * paperFactor * (1 - 0.08 * (4 - sides.length))
}

/**
 * 0–1: how white the inside of the quad is compared with the brightest
 * neutral stuff in the photo. Receipts are white; phones, placemats and
 * table stripes are not.
 */
export function paperness(pl: Planes, q: Quad): number {
  const G = 9
  let sum = 0, n = 0
  for (let i = 1; i < G; i++) {
    for (let j = 1; j < G; j++) {
      const u = i / G, v = j / G
      // Bilinear blend of the corners (TL, TR, BR, BL).
      const x = (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x)
      const y = (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y)
      if (!inside(pl, x, y)) continue
      sum += sample(pl, pl.white, x, y); n++
    }
  }
  if (!n || pl.whiteRef <= 0) return 0
  return Math.max(0, Math.min(1, sum / n / pl.whiteRef))
}

/** Least-squares line through points (PCA). Returns a point on the line and its unit direction. */
function fitLine(pts: Pt[]): { p: Pt; d: Pt } {
  let mx = 0, my = 0
  for (const p of pts) { mx += p.x; my += p.y }
  mx /= pts.length; my /= pts.length
  let sxx = 0, sxy = 0, syy = 0
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { p: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } }
}

function distToLine(l: { p: Pt; d: Pt }, q: Pt): number {
  return Math.abs((q.x - l.p.x) * l.d.y - (q.y - l.p.y) * l.d.x)
}

/**
 * Snap each side of a roughly-right quad onto the strongest nearby brightness
 * step: for points along the side, find the best step within ±`radius` px
 * along the normal, robustly fit a line through them, and re-intersect the
 * lines for the corners. Sides on the image border, or without enough
 * evidence, are left where they are.
 */
export function refineQuad(pl: Planes, q: Quad, radius = 8, stepMin = STEP_MIN): Quad {
  const c = centroid(q)
  const lines: { p: Pt; d: Pt }[] = []
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const original = { p: a, d: { x: b.x - a.x, y: b.y - a.y } }
    const n = inwardNormal(a, b, c)
    const N = 32
    const found: Pt[] = []
    for (let k = 0; k < N; k++) {
      const t = 0.08 + (0.84 * k) / (N - 1)
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
      const steps: number[] = []
      let bestStep = 0
      for (let o = -radius; o <= radius; o++) {
        const ix = x + n.x * (o + 2), iy = y + n.y * (o + 2)
        const ox = x + n.x * (o - 2), oy = y + n.y * (o - 2)
        let step = 0
        if (inside(pl, ox, oy) && inside(pl, ix, iy)) {
          for (const ch of pl.channels) {
            step = Math.max(step, Math.abs(sample(pl, ch, ix, iy) - sample(pl, ch, ox, oy)))
          }
        }
        steps.push(step)
        bestStep = Math.max(bestStep, step)
      }
      if (bestStep < stepMin) continue
      // The ±2 px probe sees a sharp edge over a short run of offsets: take
      // the middle of the run around the peak, not whichever end came first.
      const peak = steps.indexOf(bestStep)
      let lo = peak, hi = peak
      while (lo > 0 && steps[lo - 1] >= 0.9 * bestStep) lo--
      while (hi < steps.length - 1 && steps[hi + 1] >= 0.9 * bestStep) hi++
      const o = (lo + hi) / 2 - radius
      found.push({ x: x + n.x * o, y: y + n.y * o })
    }
    if (found.length < N / 2) { lines.push(original); continue }
    let line = fitLine(found)
    for (let pass = 0; pass < 2; pass++) {
      const keep = found.filter(p => distToLine(line, p) <= 2)
      if (keep.length < N / 3) break
      line = fitLine(keep)
    }
    lines.push(line)
  }
  const out: Pt[] = []
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4], l2 = lines[i]
    const hit = intersectLines(
      l1.p, { x: l1.p.x + l1.d.x, y: l1.p.y + l1.d.y },
      l2.p, { x: l2.p.x + l2.d.x, y: l2.p.y + l2.d.y },
    )
    if (!hit || Math.hypot(hit.p.x - q[i].x, hit.p.y - q[i].y) > radius * 3) return q
    out.push(hit.p)
  }
  return isConvexQuad(out) ? (out as Quad) : q
}
