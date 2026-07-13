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

// ── OpenCV-backed operations (require loadScanner() to have resolved) ────────

type Source = HTMLImageElement | HTMLCanvasElement

function sourceSize(source: Source): { w: number; h: number } {
  return source instanceof HTMLImageElement
    ? { w: source.naturalWidth, h: source.naturalHeight }
    : { w: source.width, h: source.height }
}

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
 * Detect the receipt/paper quad in an image. Returns fractional corners
 * (TL, TR, BR, BL) or null if OpenCV can't find a confident quad.
 */
export function detectCorners(source: Source): CropCorners | null {
  const cv = window.cv
  const Jscanify = window.jscanify
  if (!cv || !Jscanify) return null
  const work = toWorkCanvas(source)
  const scanner = new Jscanify()
  const mat = cv.imread(work)
  try {
    const contour = scanner.findPaperContour(mat)
    if (!contour) return null
    const corners: JscanifyCorners = scanner.getCornerPoints(contour)
    return jscanifyToCropCorners(corners, work.width, work.height)
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
