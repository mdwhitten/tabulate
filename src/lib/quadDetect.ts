/**
 * Receipt quad detector (OpenCV.js).
 *
 * Why not just "Canny → biggest 4-point contour"? On a real photo that picks
 * up the printed text, wood grain and shadows, and the paper outline is rarely
 * one clean closed contour. Instead:
 *
 *  1. Work on a small image and erase the print with a morphological close, so
 *     the receipt becomes one flat bright blob.
 *  2. Segment it several independent ways (brightness, "whiteness", and
 *     regions enclosed by edges) — each way fails on different photos.
 *  3. Turn every region into a quad that *encloses* it (so torn / rounded /
 *     off-frame corners don't matter) and score each quad against the image:
 *     do its sides actually sit on a paper edge?
 *  4. Snap the winner's sides onto the exact edge.
 *
 * Returns null when nothing scores well enough — the caller then shows default
 * corners rather than a confidently wrong crop.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  type Planes, type Pt, type Quad,
  orderQuad, pointInQuad, polygonArea, reduceToQuad, refineQuad, scoreQuad,
} from './quadGeometry'

/** Long side (px) of the image detection runs on. */
export const DETECT_MAX = 512
/** Minimum score (0–1) for a detection to be trusted. */
export const MIN_SCORE = 0.5

const MIN_REGION_FRAC = 0.04    // ignore regions smaller than this share of the frame
const MAX_REGIONS_PER_MASK = 5

interface Candidate { quad: Quad; score: number; area: number }

/** `p`-th percentile (0–1) of 8-bit values, via a histogram. */
export function percentile(data: Uint8Array, p: number): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  let acc = 0
  const target = data.length * p
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) return v
  }
  return 255
}

function contourPoints(mat: any): Pt[] {
  const d = mat.data32S
  const pts: Pt[] = []
  for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] })
  return pts
}

/**
 * Fallback when the paper's edges can't be seen: the tight rotated box around
 * the printed text, padded by a small margin. `closed` is `gray` with the
 * print erased (so closed − gray lights up exactly the print). Returns null
 * unless the print forms one compact block (a textured background doesn't).
 */
function textBlockQuad(cv: any, gray: any, closed: any, k: number): Quad | null {
  const ink = new cv.Mat()
  const blob = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const join = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2 * k + 1, 2 * k + 1))
  try {
    cv.subtract(closed, gray, ink)
    cv.threshold(ink, ink, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)
    const inkTotal = cv.countNonZero(ink)
    if (!inkTotal) return null
    cv.dilate(ink, blob, join)                      // merge characters and lines into a block
    cv.findContours(blob, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    let bestI = -1, bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i)
      const a = cv.contourArea(c)
      c.delete()
      if (a > bestArea) { bestArea = a; bestI = i }
    }
    if (bestI < 0) return null
    const c = contours.get(bestI)
    const rect = cv.minAreaRect(c)
    const bounds = cv.boundingRect(c)
    c.delete()
    const frame = gray.cols * gray.rows
    const rectArea = rect.size.width * rect.size.height
    if (rectArea < 0.04 * frame || rectArea > 0.8 * frame) return null
    if (bestArea / rectArea < 0.7) return null      // not a solid block
    // Most of the photo's "ink" must sit in this block, else it's just texture.
    const roi = ink.roi(bounds)
    const inkInside = cv.countNonZero(roi)
    roi.delete()
    if (inkInside / inkTotal < 0.7) return null
    // The dilation grew the block by k on every side; receipts keep a margin
    // of a few % around the print, so net padding is small.
    const pad = Math.min(rect.size.width, rect.size.height) * 0.04 - k
    const padded = new cv.RotatedRect(
      rect.center,
      new cv.Size(rect.size.width + 2 * pad, rect.size.height + 2 * pad),
      rect.angle,
    )
    return orderQuad(cv.RotatedRect.points(padded) as Pt[])
  } catch {
    return null
  } finally {
    ink.delete(); blob.delete(); contours.delete(); hierarchy.delete(); join.delete()
  }
}

/**
 * Detect the paper quad in an RGBA `cv.Mat` no larger than ~DETECT_MAX.
 * Returns corners TL, TR, BR, BL in the mat's pixel coordinates, or null.
 */
export function detectQuad(cv: any, rgba: any): Quad | null {
  const mats: any[] = []
  const track = <T>(m: T): T => { mats.push(m); return m }
  try {
    const w = rgba.cols, h = rgba.rows
    const k = Math.max(5, Math.round(Math.max(w, h) / 50) | 1)   // ~2% of the long side, odd

    // Channels: luminance, and "whiteness" = min(R,G,B), which stays low for
    // anything coloured (wood, skin, cloth) however bright it is.
    const gray = track(new cv.Mat())
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    const planes = track(new cv.MatVector())
    cv.split(rgba, planes)
    const white = track(new cv.Mat())
    const r = track(planes.get(0)), g = track(planes.get(1)), b = track(planes.get(2))
    cv.min(r, g, white)
    cv.min(white, b, white)

    const rawGray = track(gray.clone())

    // Erase dark print: close (dilate→erode) then smooth.
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)))
    for (const ch of [gray, white]) {
      cv.morphologyEx(ch, ch, cv.MORPH_CLOSE, kernel)
      cv.medianBlur(ch, ch, 5)
    }

    const whiteData = new Uint8Array(white.data)
    const pl: Planes = {
      w, h,
      channels: [new Uint8Array(gray.data), whiteData],
      white: whiteData,
      whiteRef: percentile(whiteData, 0.9),
    }

    // ── Candidate region masks ───────────────────────────────────────────────
    const masks: any[] = []
    const outlines: any[] = []
    const small = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)))
    for (const ch of [white, gray]) {
      const m = track(new cv.Mat())
      cv.threshold(ch, m, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)
      cv.morphologyEx(m, m, cv.MORPH_OPEN, small)   // cut thin bridges to other bright stuff
      masks.push(m)
    }
    {
      // Off-white receipt on a brighter surface: the paper is the *dark* side.
      const m = track(new cv.Mat())
      cv.threshold(gray, m, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU)
      cv.morphologyEx(m, m, cv.MORPH_OPEN, small)
      masks.push(m)
    }
    // Regions enclosed by edges. Besides the plain channels, use heavily
    // smoothed copies (speckled worktops otherwise shatter into edge confetti)
    // and a low-threshold pass with wider sealing for faint, gappy outlines.
    const three = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)))
    const smooth = [gray, white].map(ch => {
      const m = track(new cv.Mat())
      cv.GaussianBlur(ch, m, new cv.Size(9, 9), 0, 0, cv.BORDER_DEFAULT)
      return m
    })
    const edgePasses: [any, number, number, any][] = [
      [gray, 20, 60, three], [white, 20, 60, three],
      [gray, 50, 150, three], [white, 50, 150, three],
      [smooth[0], 15, 45, three], [smooth[1], 15, 45, three],
      [smooth[0], 6, 18, small], [smooth[1], 6, 18, small],
    ]
    for (const [ch, lo, hi, seal] of edgePasses) {
      const e = track(new cv.Mat())
      cv.Canny(ch, e, lo, hi)
      cv.dilate(e, e, seal)
      // The edge strokes themselves: an outline with gaps never encloses a
      // region, but the hull of its pieces is still the paper.
      outlines.push(track(e.clone()))
      cv.bitwise_not(e, e)                          // regions enclosed by edges
      masks.push(e)
    }

    // ── Regions → enclosing quads → score ────────────────────────────────────
    const frame = w * h
    const candidates: Candidate[] = []
    const consider = (pts: Pt[] | null, regionArea: number) => {
      if (!pts || pts.length !== 4) return
      const quad = orderQuad(pts)
      const area = polygonArea(quad)
      if (area <= 0) return
      const score = scoreQuad(pl, quad, regionArea / area)
      if (score > 0) candidates.push({ quad, score, area })
    }
    /** Enclosing quads of a point set (given as an Nx1 CV_32SC2 mat) covering `area` px. */
    const considerShape = (pointsMat: any, area: number) => {
      const hull = new cv.Mat()
      const poly = new cv.Mat()
      try {
        cv.convexHull(pointsMat, hull, false, true)
        cv.approxPolyDP(hull, poly, 0.004 * cv.arcLength(hull, true), true)
        consider(reduceToQuad(contourPoints(poly)), area)
        // Second opinion: the min-area rectangle (robust when the hull is ragged).
        consider(cv.RotatedRect.points(cv.minAreaRect(hull)) as Pt[], area)
      } finally {
        hull.delete(); poly.delete()
      }
    }

    /** Area of the convex hull of a contour. */
    const hullArea = (c: any): number => {
      const hull = new cv.Mat()
      try {
        cv.convexHull(c, hull, false, true)
        return cv.contourArea(hull)
      } finally {
        hull.delete()
      }
    }
    const sources: { mask: any; outline: boolean }[] = [
      ...masks.map(mask => ({ mask, outline: false })),
      ...outlines.map(mask => ({ mask, outline: true })),
    ]
    for (const { mask, outline } of sources) {
      const contours = track(new cv.MatVector())
      const hierarchy = track(new cv.Mat())
      cv.findContours(mask, contours, hierarchy, outline ? cv.RETR_EXTERNAL : cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
      let regions: { pts: Int32Array; area: number }[] = []
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i)
        // Outline strokes have almost no area of their own — size them by their hull.
        const area = outline ? hullArea(c) : cv.contourArea(c)
        // Skip specks, and the frame-filling background region.
        if (area >= (outline ? 0.01 : MIN_REGION_FRAC) * frame && area <= 0.97 * frame) {
          regions.push({ pts: new Int32Array(c.data32S), area })
        }
        c.delete()
      }
      regions.sort((a, b2) => b2.area - a.area)
      regions = regions.slice(0, MAX_REGIONS_PER_MASK)
      // Each region alone, then unions of 2–3: a fold, shadow or dark band
      // often splits one receipt into several regions.
      const n = regions.length
      for (let bits = 1; bits < 1 << n; bits++) {
        const picked = regions.filter((_, i) => bits & (1 << i))
        if (picked.length > 3) continue
        const total = picked.reduce((a, r2) => a + r2.pts.length, 0)
        const all = new Int32Array(total)
        let off = 0
        for (const r2 of picked) { all.set(r2.pts, off); off += r2.pts.length }
        const m = cv.matFromArray(total / 2, 1, cv.CV_32SC2, all)
        try {
          // Outlines can't say how much of the quad they cover; trust the sides.
          considerShape(m, outline ? Infinity : picked.reduce((a, r2) => a + r2.area, 0))
        } finally {
          m.delete()
        }
      }
    }

    const clamp = (q: Quad): Quad => q.map(p => ({
      x: Math.max(0, Math.min(w - 1, p.x)),
      y: Math.max(0, Math.min(h - 1, p.y)),
    })) as Quad

    // Best score first; among equals the tightest quad (enclosing quads only ever err outwards).
    candidates.sort((a, b2) => b2.score - a.score || a.area - b2.area)
    let winner = candidates[0]
    if (!winner || winner.score < MIN_SCORE) {
      // No visible paper edge (white receipt on a white counter). Fall back to
      // the block of printed text, nudged out to any faint edge nearby.
      const block = textBlockQuad(cv, rawGray, gray, k)
      return block ? clamp(refineQuad(pl, block, 12, 5)) : null
    }
    // A sub-rectangle of the receipt (above a fold, a boxed header…) can score
    // as well as the whole thing — prefer a near-equal candidate that contains it.
    for (const c of candidates) {
      if (c.score < 0.9 * candidates[0].score) break
      if (c.area > winner.area * 1.1 && winner.quad.every(p => pointInQuad(p, c.quad, 6))) winner = c
    }
    const refined = refineQuad(pl, winner.quad)
    // Keep the refinement unless it clearly made the fit worse (a tighter quad
    // is slightly smaller, which alone costs a little score).
    const out = scoreQuad(pl, refined, 1) >= 0.9 * scoreQuad(pl, winner.quad, 1) ? refined : winner.quad
    return clamp(out)
  } catch {
    return null
  } finally {
    for (const m of mats) { try { m.delete() } catch { /* already freed */ } }
  }
}
