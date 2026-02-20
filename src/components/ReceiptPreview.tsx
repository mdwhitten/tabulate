import { useState } from 'react'
import { ImageIcon, FileText, AlertCircle, Scissors } from 'lucide-react'
import { cn } from '../lib/utils'
import { receiptThumbnailUrl } from '../api/receipts'

interface ReceiptPreviewProps {
  ocrText: string | null
  receiptId: number
  thumbnailPath: string | null
  /** Called when user clicks Edit Crop; parent opens CropModal + increments imgCacheBust on complete */
  onEditCrop?: () => void
  /** Increment to force the thumbnail to reload after a re-crop */
  imgCacheBust?: number
}

type Tab = 'image' | 'ocr'

export function ReceiptPreview({
  ocrText,
  receiptId,
  thumbnailPath,
  onEditCrop,
  imgCacheBust = 0,
}: ReceiptPreviewProps) {
  const [tab, setTab]           = useState<Tab>(thumbnailPath ? 'image' : 'ocr')
  const [imgError, setImgError] = useState(false)

  const hasImage = Boolean(thumbnailPath) && !imgError

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-100 px-1 pt-1 gap-1 shrink-0">
        {([
          { id: 'image', label: 'Receipt Image', icon: <ImageIcon className="w-3.5 h-3.5" /> },
          { id: 'ocr',   label: 'OCR Text',      icon: <FileText  className="w-3.5 h-3.5" /> },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors',
              tab === t.id
                ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-500'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Panes */}
      <div className="flex-1 overflow-auto p-3 min-h-0">
        {tab === 'image' ? (
          hasImage ? (
            <div className="flex flex-col gap-2">
              <img
                key={imgCacheBust}
                src={`${receiptThumbnailUrl(receiptId)}?_=${imgCacheBust || receiptId}`}
                alt="Receipt"
                onError={() => setImgError(true)}
                className="w-full rounded-lg object-contain"
              />
              {onEditCrop && (
                <button
                  onClick={onEditCrop}
                  className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg border border-gray-200 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  Edit Crop
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full min-h-48 bg-gray-50 rounded-xl border border-dashed border-gray-200">
              <div className="text-center text-gray-400">
                {imgError ? (
                  <>
                    <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-xs">Image unavailable</p>
                  </>
                ) : (
                  <>
                    <ImageIcon className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    <p className="text-xs">No image available</p>
                    <p className="text-[11px] mt-1 opacity-70">Upload a receipt to see the image here</p>
                  </>
                )}
              </div>
            </div>
          )
        ) : (
          <pre className="text-[11px] font-mono leading-relaxed text-gray-600 whitespace-pre-wrap break-words">
            {ocrText ?? '(No OCR text available)'}
          </pre>
        )}
      </div>
    </div>
  )
}
