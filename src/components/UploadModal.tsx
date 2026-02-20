import { useCallback, useRef, useState } from 'react'
import { Upload, X, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '../lib/utils'
import { useUploadReceipt } from '../hooks/useReceipts'
import { CropModal } from './CropModal'
import type { ProcessingResult, CropCorners } from '../api/receipts'

interface UploadModalProps {
  onClose: () => void
  onSuccess: (result: ProcessingResult) => void
}

type Stage = 'pick' | 'crop' | 'uploading'

export function UploadModal({ onClose, onSuccess }: UploadModalProps) {
  const [dragOver, setDragOver]       = useState(false)
  const [stage, setStage]             = useState<Stage>('pick')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const upload   = useUploadReceipt()

  // Step 1 — file selected: go to crop stage
  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') return
    setPendingFile(file)
    setStage('crop')
  }, [])

  // Step 2 — crop confirmed or skipped: upload
  const doUpload = useCallback(async (file: File, cropCorners?: CropCorners | null) => {
    setStage('uploading')
    try {
      const result = await upload.mutateAsync({ file, cropCorners })
      onSuccess(result)
    } catch {
      // error is on upload.error — return to pick so user can retry
      setStage('pick')
      setPendingFile(null)
    }
  }, [upload, onSuccess])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''   // reset so same file can be re-selected
  }, [handleFile])

  // ── Crop stage ─────────────────────────────────────────────────────────────

  if (stage === 'crop' && pendingFile) {
    return (
      <CropModal
        file={pendingFile}
        onConfirm={corners => doUpload(pendingFile, corners)}
        onSkip={() => doUpload(pendingFile, null)}
        onCancel={() => { setStage('pick'); setPendingFile(null) }}
      />
    )
  }

  // ── Pick / uploading stage ─────────────────────────────────────────────────

  const isPending = stage === 'uploading'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && !isPending) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Scan Receipt</h2>
          <button
            onClick={onClose}
            disabled={isPending}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drop zone */}
        <div className="p-6">
          <div
            onClick={() => !isPending && inputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            className={cn(
              'flex flex-col items-center justify-center gap-3 py-12 rounded-xl border-2 border-dashed cursor-pointer transition-all',
              dragOver
                ? 'border-[#03a9f4] bg-[#03a9f4]/5 scale-[1.01]'
                : 'border-gray-200 hover:border-[#03a9f4]/60 hover:bg-gray-50',
              isPending && 'pointer-events-none opacity-60',
            )}
          >
            {isPending ? (
              <>
                <Loader2 className="w-10 h-10 text-[#03a9f4] animate-spin" />
                <p className="text-sm font-medium text-gray-600">Processing receipt…</p>
                <p className="text-xs text-gray-400">This may take a few seconds</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 bg-[#03a9f4]/10 rounded-2xl flex items-center justify-center">
                  <Upload className="w-7 h-7 text-[#03a9f4]" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-800">
                    Drop your receipt here
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    or click to browse — JPG, PNG, PDF
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Error */}
          {upload.isError && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{(upload.error as Error).message}</span>
            </div>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={onInputChange}
          />
        </div>
      </div>
    </div>
  )
}
