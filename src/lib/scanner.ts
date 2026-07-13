/**
 * Client-side document scanner — thin wrapper over the vendored jscanify +
 * OpenCV.js (see ./opencv). Provides real paper-quad detection and true
 * perspective correction in the browser, replacing the weak server-side
 * axis-aligned edge detector.
 *
 * Callers must `await loadScanner()` (from ./opencv) before invoking
 * `detectCorners` / `extractCorrected`, and should catch failures to fall back
 * (server detection, or uploading the original image).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CropCorners } from '../api/receipts'

interface Point { x: number; y: number }

export interface JscanifyCorners {
  topLeftCorner?: Point
  topRightCorner?: Point
  bottomLeftCorner?: Point
  bottomRightCorner?: Point
}

/** Cap huge phone photos so OpenCV stays within its heap (still ample for OCR). */
const WORK_MAX = 2000

// ── Pure corner-format helpers (unit-tested; no OpenCV / DOM needed) ─────────

/**
 * Convert jscanify's corner object (pixel coords) to fractional CropCorners
 * ordered TL, TR, BR, BL. Returns null if any corner is missing or the image
 * has no area.
 */
export function jscanifyToCropCorners(
  c: JscanifyCorners, width: number, height: number,
): CropCorners | null {
  const { topLeftCorner: tl, topRightCorner: tr, bottomRightCorner: br, bottomLeftCorner: bl } = c
  if (!tl || !tr || !br || !bl || width <= 0 || height <= 0) return null
  return [
    [tl.x / width, tl.y / height],
    [tr.x / width, tr.y / height],
    [br.x / width, br.y / height],
    [bl.x / width, bl.y / height],
  ]
}

/** Convert fractional CropCorners (TL, TR, BR, BL) to jscanify pixel corners. */
export function cropCornersToJscanify(
  c: CropCorners, width: number, height: number,
): Required<JscanifyCorners> {
  const [tl, tr, br, bl] = c
  return {
    topLeftCorner:     { x: tl[0] * width, y: tl[1] * height },
    topRightCorner:    { x: tr[0] * width, y: tr[1] * height },
    bottomRightCorner: { x: br[0] * width, y: br[1] * height },
    bottomLeftCorner:  { x: bl[0] * width, y: bl[1] * height },
  }
}

/**
 * Output size (px) for the warped quad: the longest of each pair of opposing
 * edges, so the corrected image keeps the receipt's full detail.
 */
export function outputSize(c: CropCorners, width: number, height: number): { w: number; h: number } {
  const px = c.map(([fx, fy]) => [fx * width, fy * height])
  const [tl, tr, br, bl] = px
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const w = Math.max(dist(tl, tr), dist(bl, br))
  const h = Math.max(dist(tl, bl), dist(tr, br))
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) }
}

type Source = HTMLImageElement | HTMLCanvasElement

function sourceSize(source: Source): { w: number; h: number } {
  return source instanceof HTMLImageElement
    ? { w: source.naturalWidth, h: source.naturalHeight }
    : { w: source.width, h: source.height }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality))
}

// ── Canvas-only helpers (no OpenCV needed — used as fallbacks) ───────────────

const FULL_CORNERS: CropCorners = [[0, 0], [1, 0], [1, 1], [0, 1]]

/**
 * Axis-aligned crop (bounding box of `cornersFrac`) via a plain canvas — the
 * fallback used when OpenCV isn't available to do a true perspective warp.
 * Omit `cornersFrac` to export the whole image (used for "reset to original").
 */
export function cropToBlob(
  source: Source,
  cornersFrac: CropCorners = FULL_CORNERS,
  quality = 0.92,
): Promise<Blob> {
  const { w, h } = sourceSize(source)
  const xs = cornersFrac.map(c => c[0] * w)
  const ys = cornersFrac.map(c => c[1] * h)
  const x0 = Math.max(0, Math.floor(Math.min(...xs)))
  const x1 = Math.min(w, Math.ceil(Math.max(...xs)))
  const y0 = Math.max(0, Math.floor(Math.min(...ys)))
  const y1 = Math.min(h, Math.ceil(Math.max(...ys)))
  const cw = Math.max(1, x1 - x0)
  const ch = Math.max(1, y1 - y0)
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  canvas.getContext('2d')!.drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch)
  return canvasToBlob(canvas, quality)
}

// ── OpenCV-backed operations (require loadScanner() to have resolved) ────────

/** Draw the source into a (possibly downscaled) canvas capped at WORK_MAX px. */
function toWorkCanvas(source: Source): HTMLCanvasElement {
  const { w: sw, h: sh } = sourceSize(source)
  const scale = Math.min(1, WORK_MAX / Math.max(sw || 1, sh || 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

/**
 * Reject implausible detections (a receipt should be a convex-ish quad that
 * fills a reasonable fraction of the frame). This stops the detector from
 * seeding a garbage crop — e.g. the whole photo (grabbed the table/shadow) or a
 * tiny speck — which is worse than showing default corners for the user to drag.
 */
export function plausibleQuad(c: CropCorners): boolean {
  // Shoelace area in fractional units (0–1 of the image).
  let area = 0
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = c[i]
    const [x2, y2] = c[(i + 1) % 4]
    area += x1 * y2 - x2 * y1
  }
  area = Math.abs(area) / 2
  if (area < 0.10 || area > 0.98) return false
  // Reject a box that spans essentially the entire frame in both axes.
  const xs = c.map(p => p[0])
  const ys = c.map(p => p[1])
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  if (spanX > 0.985 && spanY > 0.985) return false
  return true
}

/** Order 4 points as TL, TR, BR, BL using coordinate sums/diffs. */
function orderCorners(pts: { x: number; y: number }[], w: number, h: number): CropCorners {
  const bySum  = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y))
  const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y))
  const tl = bySum[0], br = bySum[3]        // smallest / largest x+y
  const bl = byDiff[0], tr = byDiff[3]      // smallest / largest x−y
  return [
    [tl.x / w, tl.y / h], [tr.x / w, tr.y / h],
    [br.x / w, br.y / h], [bl.x / w, bl.y / h],
  ]
}

/**
 * Custom quad detector: Canny + dilate → largest 4-point convex `approxPolyDP`
 * contour. More reliable than jscanify's `minAreaRect` extremes for skewed
 * receipts. Returns fractional corners or null. Fully defensive — any OpenCV
 * error yields null (callers fall back to jscanify, then to default corners).
 */
function detectQuadApprox(cv: any, work: HTMLCanvasElement): CropCorners | null {
  const src = cv.imread(work)
  const gray = new cv.Mat()
  const edges = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  let best: any = null
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT)
    cv.Canny(gray, edges, 50, 150)
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
    cv.dilate(edges, edges, kernel)
    kernel.delete()
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    let bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i)
      const area = cv.contourArea(c)
      if (area > bestArea) {
        const approx = new cv.Mat()
        cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true)
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          if (best) best.delete()
          best = approx
          bestArea = area
        } else {
          approx.delete()
        }
      }
      c.delete()
    }
    if (!best) return null
    const pts = [0, 1, 2, 3].map(i => ({ x: best.data32S[i * 2], y: best.data32S[i * 2 + 1] }))
    const corners = orderCorners(pts, work.width, work.height)
    return plausibleQuad(corners) ? corners : null
  } catch {
    return null
  } finally {
    if (best) best.delete()
    src.delete(); gray.delete(); edges.delete(); contours.delete(); hierarchy.delete()
  }
}

/**
 * Detect the receipt/paper quad in an image. Returns fractional corners
 * (TL, TR, BR, BL) or null if OpenCV can't find a confident quad.
 */
export function detectCorners(source: Source): CropCorners | null {
  const cv = window.cv
  const Jscanify = window.jscanify
  if (!cv || !Jscanify) return null
  const work = toWorkCanvas(source)

  // Prefer the approxPolyDP detector; gate its result.
  const approx = detectQuadApprox(cv, work)
  if (approx) return approx

  // Fall back to jscanify's detector, also gated.
  const scanner = new Jscanify()
  const mat = cv.imread(work)
  try {
    const contour = scanner.findPaperContour(mat)
    if (!contour) return null
    const corners = jscanifyToCropCorners(scanner.getCornerPoints(contour), work.width, work.height)
    return corners && plausibleQuad(corners) ? corners : null
  } catch {
    return null
  } finally {
    mat.delete()
  }
}

/**
 * Perspective-correct the image to the given (or auto-detected) corners and
 * return a JPEG blob. Rejects if OpenCV is unavailable or no quad is found.
 */
export function extractCorrected(
  source: Source,
  cornersFrac?: CropCorners | null,
  quality = 0.92,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const cv = window.cv
    const Jscanify = window.jscanify
    if (!cv || !Jscanify) { reject(new Error('scanner unavailable')); return }
    const work = toWorkCanvas(source)
    const frac = cornersFrac ?? detectCorners(work)
    if (!frac) { reject(new Error('no paper detected')); return }
    const { w, h } = outputSize(frac, work.width, work.height)
    const cornerPoints = cropCornersToJscanify(frac, work.width, work.height)
    const scanner = new Jscanify()
    const out: HTMLCanvasElement | null = scanner.extractPaper(work, w, h, cornerPoints)
    if (!out) { reject(new Error('extract failed')); return }
    out.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality)
  })
}
