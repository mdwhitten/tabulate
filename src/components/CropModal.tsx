/**
 * CropModal — canvas-based receipt crop editor.
 *
 * Usage:
 *   <CropModal file={file} onConfirm={corners => ...} onSkip={() => ...} onCancel={() => ...} />
 *   <CropModal receiptId={id} onConfirm={corners => ...} onCancel={() => ...} />
 *
 * - Pass `file` for new uploads (pre-upload crop).
 * - Pass `receiptId` for editing the crop of an existing receipt.
 * - `onSkip` (optional) shown when `file` is provided — uploads without crop.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { CropCorners } from '../api/receipts'
import { detectEdges, detectEdgesRaw, receiptImageUrl } from '../api/receipts'

const HANDLE_R = 14   // corner handle radius, canvas px
const MAX_W    = 600  // max canvas display width
const MAX_H    = 500  // max canvas display height

type Corner = [number, number]
type Corners = [Corner, Corner, Corner, Corner]  // TL, TR, BR, BL

interface CropModalProps {
  /** For new uploads — the file to show and (optionally) skip */
  file?: File | null
  /** For editing an existing receipt's crop */
  receiptId?: number | null
  /** Called with fractional corners when user clicks Apply */
  onConfirm: (corners: CropCorners) => void
  /** Called when user clicks Skip (new upload only, uploads without crop) */
  onSkip?: () => void
  onCancel: () => void
}

export function CropModal({ file, receiptId, onConfirm, onSkip, onCancel }: CropModalProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const imgRef       = useRef<HTMLImageElement | null>(null)
  const scaleRef     = useRef(1)
  const cornersRef   = useRef<Corners>([[0,0],[0,0],[0,0],[0,0]])
  const draggingRef  = useRef<number | null>(null)

  const [ready, setReady]     = useState(false)
  const [detecting, setDetecting] = useState(false)

  // ── Draw ──────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')!
    const c   = cornersRef.current

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--tab-accent').trim() || '#03a9f4'

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    // Darken outside quad (even-odd fill)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, canvas.width, canvas.height)
    ctx.moveTo(c[0][0], c[0][1])
    c.forEach(([x, y]) => ctx.lineTo(x, y))
    ctx.closePath()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fill('evenodd')
    ctx.restore()

    // Quad outline
    ctx.beginPath()
    ctx.moveTo(c[0][0], c[0][1])
    c.forEach(([x, y]) => ctx.lineTo(x, y))
    ctx.closePath()
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.stroke()

    // Corner handles
    c.forEach(([x, y]) => {
      // outer white circle
      ctx.beginPath()
      ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.strokeStyle = accent
      ctx.lineWidth = 2
      ctx.stroke()
      // inner blue dot
      ctx.beginPath()
      ctx.arc(x, y, HANDLE_R * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = accent
      ctx.fill()
    })
  }, [])

  // ── Init canvas from image ────────────────────────────────────────────────

  const initCanvas = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current!
    const scale  = Math.min(MAX_W / img.naturalWidth, MAX_H / img.naturalHeight, 1)
    scaleRef.current  = scale
    canvas.width  = Math.round(img.naturalWidth  * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    imgRef.current = img
  }, [])

  function defaultCorners(): Corners {
    const canvas = canvasRef.current!
    const W = canvas.width, H = canvas.height
    const p = Math.round(Math.min(W, H) * 0.04)
    return [[p, p], [W - p, p], [W - p, H - p], [p, H - p]]
  }

  function fracToCanvas(frac: CropCorners): Corners {
    const canvas = canvasRef.current!
    return frac.map(([fx, fy]) => [fx * canvas.width, fy * canvas.height]) as Corners
  }

  // ── Load image + run edge detection ──────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function load() {
      let imageUrl: string
      if (file) {
        imageUrl = URL.createObjectURL(file)
      } else if (receiptId != null) {
        imageUrl = receiptImageUrl(receiptId)
      } else {
        return
      }

      const img = new Image()
      img.src = imageUrl

      await new Promise<void>((resolve, reject) => {
        img.onload  = () => resolve()
        img.onerror = () => reject(new Error('Failed to load image'))
      })

      if (cancelled) return

      // Single rAF to ensure React has committed before we read canvasRef
      await new Promise<void>(r => requestAnimationFrame(() => r()))
      if (cancelled) return

      initCanvas(img)
      cornersRef.current = defaultCorners()
      setReady(true)
      // draw() called in a follow-up rAF after React shows the canvas
      requestAnimationFrame(() => { if (!cancelled) draw() })

      // Background edge detection
      setDetecting(true)
      try {
        const detected = file
          ? await detectEdgesRaw(file)
          : await detectEdges(receiptId!)
        if (!cancelled && detected) {
          cornersRef.current = fracToCanvas(detected)
          draw()
        }
      } catch { /* leave default corners */ }
      finally {
        if (!cancelled) setDetecting(false)
      }

      if (file) URL.revokeObjectURL(imageUrl)
    }

    load().catch(console.error)
    return () => { cancelled = true }
  }, [file, receiptId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pointer events ────────────────────────────────────────────────────────

  function getCanvasXY(e: React.MouseEvent | React.TouchEvent): [number, number] {
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()
    const sx     = canvas.width  / rect.width
    const sy     = canvas.height / rect.height
    let clientX: number, clientY: number
    if ('touches' in e) {
      clientX = e.touches[0]?.clientX ?? e.changedTouches[0].clientX
      clientY = e.touches[0]?.clientY ?? e.changedTouches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }
    return [
      Math.max(0, Math.min(canvas.width,  (clientX - rect.left) * sx)),
      Math.max(0, Math.min(canvas.height, (clientY - rect.top)  * sy)),
    ]
  }

  function onPointerDown(e: React.MouseEvent | React.TouchEvent) {
    const [mx, my] = getCanvasXY(e)
    draggingRef.current = null
    cornersRef.current.forEach(([x, y], i) => {
      if (Math.hypot(mx - x, my - y) < HANDLE_R + 4) draggingRef.current = i
    })
  }

  function onPointerMove(e: React.MouseEvent | React.TouchEvent) {
    if (draggingRef.current === null) return
    const [mx, my] = getCanvasXY(e)
    cornersRef.current[draggingRef.current] = [mx, my]
    draw()
  }

  function onPointerUp() {
    draggingRef.current = null
  }

  // ── Confirm ───────────────────────────────────────────────────────────────

  function handleConfirm() {
    const canvas = canvasRef.current!
    const frac   = cornersRef.current.map(([x, y]) => [
      x / canvas.width,
      y / canvas.height,
    ]) as CropCorners
    onConfirm(frac)
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Crop Receipt</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Drag the corner handles to adjust the crop area
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Canvas area — canvas is always in DOM so canvasRef is always attached */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center min-h-0 bg-gray-50">
          {/* Spinner: visible until ready */}
          {!ready && (
            <div className="absolute flex flex-col items-center gap-3 py-16 text-gray-400 pointer-events-none">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--tab-accent)]" />
              <p className="text-sm">Loading image…</p>
            </div>
          )}
          {/* Canvas: always rendered so ref attaches; hidden until ready */}
          <div className="relative" style={{ display: ready ? 'block' : 'none' }}>
            <canvas
              ref={canvasRef}
              className="rounded-lg block max-w-full"
              style={{ cursor: 'crosshair', userSelect: 'none', touchAction: 'none' }}
              onMouseDown={onPointerDown}
              onMouseMove={onPointerMove}
              onMouseUp={onPointerUp}
              onMouseLeave={onPointerUp}
              onTouchStart={e => { e.preventDefault(); onPointerDown(e) }}
              onTouchMove={e => { e.preventDefault(); onPointerMove(e) }}
              onTouchEnd={e => { e.preventDefault(); onPointerUp() }}
            />
            {detecting && (
              <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/60 text-white text-xs px-2.5 py-1.5 rounded-full">
                <Loader2 className="w-3 h-3 animate-spin" />
                Detecting edges…
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 shrink-0">
          {onSkip ? (
            <button
              onClick={onSkip}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Skip — Use Full Image
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={handleConfirm}
            disabled={!ready}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--tab-accent)] text-white text-sm font-semibold rounded-xl hover:bg-[var(--tab-accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply Crop &amp; Scan
          </button>
        </div>
      </div>
    </div>
  )
}
