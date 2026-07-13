import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, X, Loader2, AlertCircle, Check, Circle, Camera, Trash2, Plus } from 'lucide-react'
import { cn } from '../lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { receiptKeys } from '../hooks/useReceipts'
import { CropModal } from './CropModal'
import { uploadReceipt } from '../api/receipts'
import type { ProcessingResult, CropCorners } from '../api/receipts'
import { loadScanner } from '../lib/opencv'
import { extractCorrected } from '../lib/scanner'

// ── Processing step indicator (single receipt) ────────────────────────────────

const PROCESSING_STEPS = [
  { label: 'Uploading image',    delay: 0 },
  { label: 'Running OCR',        delay: 1500 },
  { label: 'Analyzing with AI',  delay: 3500 },
  { label: 'Categorizing items', delay: 6000 },
] as const

function ProcessingSteps() {
  const [activeStep, setActiveStep] = useState(0)

  useEffect(() => {
    const timers = PROCESSING_STEPS.slice(1).map((step, i) =>
      setTimeout(() => setActiveStep(i + 1), step.delay),
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  return (
    <div className="flex flex-col items-start gap-2.5 w-full max-w-[220px]">
      {PROCESSING_STEPS.map((step, i) => {
        const isDone   = i < activeStep
        const isActive = i === activeStep
        return (
          <div key={i} className="flex items-center gap-2.5">
            {isDone ? (
              <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <Check className="w-3 h-3 text-emerald-600" />
              </div>
            ) : isActive ? (
              <Loader2 className="w-5 h-5 text-[#03a9f4] animate-spin shrink-0" />
            ) : (
              <Circle className="w-5 h-5 text-gray-200 shrink-0" />
            )}
            <span
              className={cn(
                'text-sm transition-colors duration-300',
                isDone   && 'text-gray-400',
                isActive && 'text-gray-800 font-medium',
                !isDone && !isActive && 'text-gray-300',
              )}
            >
              {step.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface QueuedItem {
  id: number
  file: File
  url: string
  isPdf: boolean
}

function isAcceptedFile(f: File): boolean {
  return f.type.startsWith('image/') || f.type === 'application/pdf'
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

interface UploadModalProps {
  onClose: () => void
  /** Called with the ordered batch of processed receipts (one or many). */
  onBatchSuccess: (results: ProcessingResult[]) => void
}

type Stage = 'pick' | 'crop' | 'uploading'

export function UploadModal({ onClose, onBatchSuccess }: UploadModalProps) {
  const [dragOver, setDragOver] = useState(false)
  const [stage, setStage]       = useState<Stage>('pick')
  const [queue, setQueue]       = useState<QueuedItem[]>([])
  const [error, setError]       = useState<string | null>(null)
  const [done, setDone]         = useState(0)   // batch progress counter

  const fileInputRef   = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const idRef          = useRef(0)
  const qc = useQueryClient()

  // Revoke any outstanding object URLs on unmount.
  const queueRef = useRef<QueuedItem[]>([])
  useEffect(() => { queueRef.current = queue }, [queue])
  useEffect(() => () => { queueRef.current.forEach(it => URL.revokeObjectURL(it.url)) }, [])

  const addFiles = useCallback((files: File[]) => {
    const accepted = files.filter(isAcceptedFile)
    if (accepted.length === 0) return
    setError(null)
    setQueue(prev => [
      ...prev,
      ...accepted.map(file => ({
        id: idRef.current++,
        file,
        url: URL.createObjectURL(file),
        isPdf: file.type === 'application/pdf',
      })),
    ])
  }, [])

  const removeItem = useCallback((id: number) => {
    setQueue(prev => {
      const it = prev.find(q => q.id === id)
      if (it) URL.revokeObjectURL(it.url)
      return prev.filter(q => q.id !== id)
    })
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(Array.from(e.dataTransfer.files))
  }, [addFiles])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []))
    e.target.value = ''   // reset so the same file can be re-selected
  }, [addFiles])

  // ── Upload a single receipt (from the crop step or a lone PDF) ─────────────

  const uploadOne = useCallback(async (payload: File | Blob, cropCorners?: CropCorners | null) => {
    setStage('uploading')
    setError(null)
    try {
      const result = await uploadReceipt(payload, cropCorners)
      qc.invalidateQueries({ queryKey: receiptKeys.list() })
      onBatchSuccess([result])
    } catch (e) {
      setError((e as Error).message)
      setStage('pick')
    }
  }, [qc, onBatchSuccess])

  // ── Process a whole batch in parallel (skip manual crop) ───────────────────

  const processBatch = useCallback(async () => {
    setStage('uploading')
    setError(null)
    setDone(0)

    // Try to bring up the client scanner once; if it fails we upload originals.
    let scannerOk = true
    try { await loadScanner() } catch { scannerOk = false }

    const settled = await Promise.allSettled(
      queue.map(async item => {
        let payload: File | Blob = item.file
        if (scannerOk && !item.isPdf) {
          try {
            const img = await loadImage(item.url)
            payload = await extractCorrected(img)   // auto-detect + perspective-correct
          } catch { /* fall back to the original image */ }
        }
        const result = await uploadReceipt(payload)
        setDone(d => d + 1)
        return result
      }),
    )

    const results = settled
      .filter((s): s is PromiseFulfilledResult<ProcessingResult> => s.status === 'fulfilled')
      .map(s => s.value)
    const failed = settled.length - results.length

    qc.invalidateQueries({ queryKey: receiptKeys.list() })

    if (results.length === 0) {
      setError('All uploads failed. Please try again.')
      setStage('pick')
      return
    }
    if (failed > 0) {
      // Some succeeded — proceed with those but let the user know.
      console.warn(`${failed} of ${settled.length} receipts failed to upload`)
    }
    onBatchSuccess(results)
  }, [queue, qc, onBatchSuccess])

  // ── Process button: 1 image → crop; 1 PDF → upload; many → batch ───────────

  const handleProcess = useCallback(() => {
    if (queue.length === 0) return
    if (queue.length === 1) {
      const only = queue[0]
      if (only.isPdf) uploadOne(only.file, null)   // digital doc — no crop
      else setStage('crop')
      return
    }
    processBatch()
  }, [queue, uploadOne, processBatch])

  // ── Crop stage (single image) ──────────────────────────────────────────────

  if (stage === 'crop' && queue.length === 1) {
    const only = queue[0]
    return (
      <CropModal
        file={only.file}
        onConfirmImage={blob => uploadOne(blob, null)}
        onConfirm={corners => uploadOne(only.file, corners)}
        onSkip={() => uploadOne(only.file, null)}
        onCancel={() => setStage('pick')}
      />
    )
  }

  // ── Pick / uploading stage ─────────────────────────────────────────────────

  const isUploading = stage === 'uploading'
  const isBatch = queue.length > 1

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && !isUploading) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            {queue.length > 1 ? `Scan Receipts · ${queue.length}` : 'Scan Receipt'}
          </h2>
          <button
            onClick={onClose}
            disabled={isUploading}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6">
          {isUploading ? (
            /* ── Uploading ── */
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              {isBatch ? (
                <>
                  <Loader2 className="w-8 h-8 text-[#03a9f4] animate-spin" />
                  <p className="text-sm font-medium text-gray-800">
                    Processing {done} of {queue.length} receipts…
                  </p>
                  <p className="text-xs text-gray-400">Detecting edges & running OCR in parallel</p>
                </>
              ) : (
                <ProcessingSteps />
              )}
            </div>
          ) : queue.length === 0 ? (
            /* ── Empty: drop zone ── */
            <div
              onClick={() => fileInputRef.current?.click()}
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              className={cn(
                'flex flex-col items-center justify-center gap-3 py-12 rounded-xl border-2 border-dashed cursor-pointer transition-all',
                dragOver
                  ? 'border-[#03a9f4] bg-[#03a9f4]/5 scale-[1.01]'
                  : 'border-gray-200 hover:border-[#03a9f4]/60 hover:bg-gray-50',
              )}
            >
              <div className="w-14 h-14 bg-[#03a9f4]/10 rounded-2xl flex items-center justify-center">
                <Upload className="w-7 h-7 text-[#03a9f4]" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-gray-800">Drop your receipts here</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  or click to browse — one or many · JPG, PNG, PDF
                </p>
              </div>
            </div>
          ) : (
            /* ── Queue builder ── */
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              className={cn(
                'rounded-xl transition-all',
                dragOver && 'ring-2 ring-[#03a9f4]/50',
              )}
            >
              <div className="grid grid-cols-3 gap-2.5">
                {queue.map(item => (
                  <div key={item.id} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-50 group">
                    {item.isPdf ? (
                      <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 gap-1">
                        <span className="text-2xl">📄</span>
                        <span className="text-[10px] font-medium">PDF</span>
                      </div>
                    ) : (
                      <img src={item.url} alt="" className="w-full h-full object-cover" />
                    )}
                    <button
                      onClick={() => removeItem(item.id)}
                      className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add files
                </button>
                <button
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Camera className="w-4 h-4" />
                  Take photo
                </button>
              </div>

              <button
                onClick={handleProcess}
                className="w-full mt-2.5 flex items-center justify-center gap-2 h-10 bg-[#03a9f4] text-white text-sm font-semibold rounded-xl hover:bg-[#0290d1] transition-colors shadow-sm shadow-[#03a9f4]/30"
              >
                Process {queue.length} receipt{queue.length > 1 ? 's' : ''}
              </button>
            </div>
          )}

          {/* Empty-state camera shortcut */}
          {!isUploading && queue.length === 0 && (
            <button
              onClick={() => cameraInputRef.current?.click()}
              className="w-full mt-3 flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <Camera className="w-4 h-4" />
              Take a photo
            </button>
          )}

          {/* Error */}
          {error && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Hidden inputs */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={onInputChange}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onInputChange}
          />
        </div>
      </div>
    </div>
  )
}
