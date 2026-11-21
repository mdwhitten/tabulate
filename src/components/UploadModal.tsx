import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Upload, X, Loader2, AlertCircle, Check, Circle, Camera, Trash2, Plus, RotateCcw } from 'lucide-react'
import { cn } from '../lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { receiptKeys } from '../hooks/useReceipts'
import { CropModal } from './CropModal'
import {
  deleteReceipt,
  enqueueReceipt,
  getProcessingStatus,
  getReceipt,
  reprocessReceipt,
  resultFromReceipt,
} from '../api/receipts'
import type { ProcessingResult, ReceiptProcessingStatus } from '../api/receipts'
import { uploadStepViews } from '../lib/uploadProgress'
import type { UploadProgressState } from '../lib/uploadProgress'
import {
  allReady, countPhase, isSettled, isUploading, pollIds, readyResults, uploadQueueReducer,
} from '../lib/uploadQueue'
import type { UploadItem } from '../lib/uploadQueue'

// ── Processing step indicator (single receipt) ────────────────────────────────
// Driven by the receipt's real processing stage, polled from the backend (see uploadProgress.ts).

function ProcessingSteps({ progress }: { progress: UploadProgressState }) {
  const steps = uploadStepViews(progress)
  return (
    <div className="flex flex-col items-start gap-2.5 w-full max-w-[240px]" data-testid="processing-steps">
      {steps.map((step, i) => {
        const isDone   = i < progress.step
        const isActive = i === progress.step
        return (
          <div key={i} className="flex items-start gap-2.5" aria-current={isActive ? 'step' : undefined}>
            {isDone ? (
              <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <Check className="w-3 h-3 text-emerald-600" />
              </div>
            ) : isActive ? (
              <Loader2 className="w-5 h-5 text-[#03a9f4] animate-spin shrink-0" />
            ) : (
              <Circle className="w-5 h-5 text-gray-200 shrink-0" />
            )}
            <div className="flex flex-col min-w-0">
              <span
                className={cn(
                  'text-sm leading-5 transition-colors duration-300',
                  isDone   && 'text-gray-400',
                  isActive && 'text-gray-800 font-medium',
                  !isDone && !isActive && 'text-gray-300',
                )}
              >
                {step.label}
              </span>
              {step.detail && (isDone || isActive) && (
                <span className={cn('text-xs tabular-nums', isActive ? 'text-[#03a9f4]' : 'text-gray-400')}>
                  {step.detail}
                </span>
              )}
            </div>
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

/** How often to ask the server how the uploaded receipts are getting on. */
const POLL_MS = 1000

/**
 * Poll the processing state of `ids`. A receipt that finished but whose result
 * the server no longer remembers (it restarted) is loaded the ordinary way.
 */
async function fetchStatuses(ids: number[]): Promise<ReceiptProcessingStatus[]> {
  const statuses = await getProcessingStatus(ids)
  return Promise.all(statuses.map(async st => {
    if (st.status === 'processing' || st.status === 'failed' || st.result) return st
    try {
      return { ...st, result: resultFromReceipt(await getReceipt(st.id)) }
    } catch {
      return st   // try again on the next poll
    }
  }))
}

// ── One receipt's row in the batch status list ───────────────────────────────

function StatusRow({ item, thumbUrl, onRetry, onDiscard }: {
  item: UploadItem
  thumbUrl: string | null
  onRetry: () => void
  onDiscard: () => void
}) {
  const failed = item.phase === 'failed' || item.phase === 'upload-failed'
  const text =
    item.phase === 'uploading' ? 'Uploading…'
    : item.phase === 'processing' ? (item.stageText ?? 'Processing…')
    : item.phase === 'ready' ? 'Ready to review'
    : item.error ?? 'Failed'
  const title = item.phase === 'ready' && item.result ? item.result.store_name : item.name

  return (
    <li className="flex items-center gap-3 py-2" data-testid="upload-row" data-phase={item.phase}>
      <div className="w-9 h-9 rounded-lg overflow-hidden border border-gray-200 bg-gray-50 shrink-0 flex items-center justify-center text-base">
        {thumbUrl ? <img src={thumbUrl} alt="" className="w-full h-full object-cover" /> : '📄'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{title}</p>
        <p className={cn('text-xs truncate tabular-nums', failed ? 'text-red-500' : 'text-gray-400')}>{text}</p>
      </div>
      {failed ? (
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onRetry}
            title="Retry"
            aria-label={`Retry ${item.name}`}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={onDiscard}
            title="Discard"
            aria-label={`Discard ${item.name}`}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ) : item.phase === 'ready' ? (
        <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
          <Check className="w-3 h-3 text-emerald-600" />
        </div>
      ) : (
        <Loader2 className="w-5 h-5 text-[#03a9f4] animate-spin shrink-0" />
      )}
    </li>
  )
}

interface UploadModalProps {
  onClose: () => void
  /** Called with the ordered batch of processed receipts (one or many). */
  onBatchSuccess: (results: ProcessingResult[]) => void
}

type Stage = 'pick' | 'crop' | 'status'

export function UploadModal({ onClose, onBatchSuccess }: UploadModalProps) {
  const [dragOver, setDragOver] = useState(false)
  const [stage, setStage]       = useState<Stage>('pick')
  const [queue, setQueue]       = useState<QueuedItem[]>([])
  const [error, setError]       = useState<string | null>(null)
  // Receipts handed to the server so far (see uploadQueue.ts).
  const [items, dispatch] = useReducer(uploadQueueReducer, [])
  // Photos left behind when the crop walkthrough was cancelled part-way.
  const [skipped, setSkipped] = useState(0)

  const fileInputRef   = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const idRef          = useRef(0)
  const handedOffRef   = useRef(false)   // review was started for this batch
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

  // ── Upload as you go ────────────────────────────────────────────────────────
  // Each image is reviewed in the crop modal (auto-detected corners pre-filled)
  // and sent to the server the moment its crop is confirmed — while the user
  // carries on with the next one. PDFs go straight away. The server processes
  // them in the background, so from "accepted" on nothing depends on this page.

  const [cropIndex, setCropIndex] = useState(0)
  const [imageIdx, setImageIdx]   = useState<number[]>([])   // queue positions that need a crop step
  // What was sent for each file, kept so a failed upload can be retried.
  const payloadsRef = useRef(new Map<number, { payload: File | Blob; original: File | null }>())

  const startUpload = useCallback((key: number, name: string, payload: File | Blob, original: File | null) => {
    payloadsRef.current.set(key, { payload, original })
    dispatch({ type: 'start', key, name })
    enqueueReceipt(payload, original).then(
      accepted => {
        dispatch({ type: 'accepted', key, receiptId: accepted.receipt_id })
        // It exists server-side now: let the receipts list show it as processing.
        qc.invalidateQueries({ queryKey: receiptKeys.list() })
      },
      err => dispatch({
        type: 'upload-failed', key,
        error: err instanceof Error ? err.message : 'Upload failed',
      }),
    )
  }, [qc])

  const handleProcess = useCallback(() => {
    if (queue.length === 0) return
    setError(null)
    setSkipped(0)
    dispatch({ type: 'reset' })
    payloadsRef.current.clear()
    handedOffRef.current = false
    // PDFs need no crop: send them now. Images go through the crop walkthrough.
    queue.filter(it => it.isPdf).forEach(it => startUpload(it.id, it.file.name, it.file, null))
    const images = queue.map((it, i) => (it.isPdf ? -1 : i)).filter(i => i >= 0)
    setImageIdx(images)
    setCropIndex(0)
    setStage(images.length === 0 ? 'status' : 'crop')
  }, [queue, startUpload])

  const recordCrop = useCallback((payload: File | Blob, original: File | null) => {
    const item = queue[imageIdx[cropIndex]]
    startUpload(item.id, item.file.name, payload, original)
    if (cropIndex + 1 >= imageIdx.length) setStage('status')
    else setCropIndex(cropIndex + 1)
  }, [queue, cropIndex, imageIdx, startUpload])

  /** Cancel during the crop walkthrough: keep what was already sent. */
  const cancelCrop = useCallback(() => {
    setCropIndex(0)
    if (items.length === 0) { setStage('pick'); return }
    setSkipped(imageIdx.length - cropIndex)
    setStage('status')
  }, [items.length, imageIdx.length, cropIndex])

  // ── Follow the server's progress ────────────────────────────────────────────

  const idsKey = pollIds(items).join(',')
  useEffect(() => {
    if (!idsKey) return
    const ids = idsKey.split(',').map(Number)
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const statuses = await fetchStatuses(ids)
        if (stopped) return
        dispatch({ type: 'status', polled: ids, statuses })
        if (statuses.length < ids.length || statuses.some(s => s.status !== 'processing')) {
          qc.invalidateQueries({ queryKey: receiptKeys.list() })
        }
      } catch {
        // Server unreachable for a moment — processing carries on there; ask again.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS / 4)
    return () => { stopped = true; clearTimeout(timer) }
  }, [idsKey, qc])

  // Every receipt read successfully → straight on to review.
  useEffect(() => {
    if (stage !== 'status' || handedOffRef.current || !allReady(items)) return
    handedOffRef.current = true
    onBatchSuccess(readyResults(items))
  }, [stage, items, onBatchSuccess])

  // Leaving while bytes are still on their way would lose those receipts.
  const uploading = isUploading(items)
  useEffect(() => {
    if (!uploading) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])

  const retry = useCallback((item: UploadItem) => {
    setError(null)
    if (item.phase === 'upload-failed') {
      const sent = payloadsRef.current.get(item.key)
      if (sent) startUpload(item.key, item.name, sent.payload, sent.original)
    } else if (item.receiptId != null) {
      reprocessReceipt(item.receiptId).then(
        () => dispatch({ type: 'reprocess', key: item.key }),
        err => setError(err instanceof Error ? err.message : 'Retry failed'),
      )
    }
  }, [startUpload])

  const discard = useCallback(async (item: UploadItem) => {
    setError(null)
    if (item.receiptId != null) {
      try { await deleteReceipt(item.receiptId) } catch { /* already gone */ }
      qc.invalidateQueries({ queryKey: receiptKeys.list() })
    }
    dispatch({ type: 'remove', key: item.key })
  }, [qc])

  const close = useCallback(() => {
    qc.invalidateQueries({ queryKey: receiptKeys.list() })
    onClose()
  }, [qc, onClose])

  // ── Crop stage: step through each image (pre-filled corners) ────────────────

  if (stage === 'crop') {
    const item = queue[imageIdx[cropIndex]]
    if (!item) return null
    return (
      <CropModal
        key={item.id}
        file={item.file}
        onConfirmImage={blob => recordCrop(blob, item.file)}
        onSkip={() => recordCrop(item.file, null)}
        onCancel={cancelCrop}
      />
    )
  }

  // ── Pick / status stage ────────────────────────────────────────────────────

  // With everything discarded there is nothing to show: back to the picker.
  const isStatus = stage === 'status' && items.length > 0
  const settled  = isSettled(items)
  const ready    = readyResults(items)
  const failures = countPhase(items, 'failed', 'upload-failed')
  const single   = items.length === 1 ? items[0] : null
  const thumbFor = (key: number) => {
    const q = queue.find(it => it.id === key)
    return q && !q.isPdf ? q.url : null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && !uploading) close() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            {queue.length > 1 ? `Scan Receipts · ${queue.length}` : 'Scan Receipt'}
          </h2>
          <button
            onClick={close}
            disabled={uploading}
            aria-label="Close"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6">
          {isStatus ? (
            /* ── Uploading / processing ── */
            <div data-testid="upload-status">
              {single && (single.phase === 'uploading' || single.phase === 'processing') ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <ProcessingSteps progress={single.progress} />
                </div>
              ) : single && single.phase !== 'ready' ? (
                <div className="py-6">
                  <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{single.error ?? 'Could not read this receipt'}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => retry(single)}
                      className="flex-1 flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg bg-[#03a9f4] text-white hover:bg-[#0290d1] transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Try again
                    </button>
                    <button
                      onClick={() => void discard(single)}
                      className="flex-1 flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Discard
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-800">
                    {settled
                      ? `${ready.length} of ${items.length} receipts ready`
                      : `Processing receipts… ${ready.length} of ${items.length} ready`}
                  </p>
                  <ul className="mt-2 divide-y divide-gray-100 max-h-72 overflow-y-auto">
                    {items.map(item => (
                      <StatusRow
                        key={item.key}
                        item={item}
                        thumbUrl={thumbFor(item.key)}
                        onRetry={() => retry(item)}
                        onDiscard={() => void discard(item)}
                      />
                    ))}
                  </ul>
                </>
              )}

              {skipped > 0 && (
                <p className="mt-3 text-xs text-amber-600">
                  {skipped} photo{skipped > 1 ? 's were' : ' was'} not uploaded because cropping was cancelled.
                </p>
              )}

              {/* What the user can safely do right now */}
              {uploading ? (
                <p className="mt-4 text-xs text-gray-400 text-center">
                  Uploading — keep this window open until it finishes.
                </p>
              ) : !settled ? (
                <div className="mt-4 text-center">
                  <p className="text-xs text-gray-400">
                    Uploaded. You can close this window — {items.length > 1 ? 'they' : 'it'} will finish in the
                    background and appear in your receipts.
                  </p>
                  <button
                    onClick={close}
                    className="mt-2 text-xs font-semibold text-[#03a9f4] hover:text-[#0290d1] transition-colors"
                  >
                    Continue in background
                  </button>
                </div>
              ) : failures > 0 && !single ? (
                <div className="mt-4 flex items-center gap-2">
                  {ready.length > 0 && (
                    <button
                      onClick={() => onBatchSuccess(ready)}
                      className="flex-1 h-10 bg-[#03a9f4] text-white text-sm font-semibold rounded-xl hover:bg-[#0290d1] transition-colors"
                    >
                      Review {ready.length} receipt{ready.length > 1 ? 's' : ''}
                    </button>
                  )}
                  <button
                    onClick={close}
                    className="flex-1 h-10 text-sm font-semibold rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Close
                  </button>
                </div>
              ) : null}
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
          {!isStatus && queue.length === 0 && (
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
