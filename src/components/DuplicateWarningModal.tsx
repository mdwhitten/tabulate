import { AlertTriangle, X } from 'lucide-react'
import type { DuplicateMatch } from '../types'
import { fmt } from '../lib/utils'

interface DuplicateWarningModalProps {
  duplicates: DuplicateMatch[]
  /** Called when the user chooses to continue despite the duplicate. */
  onContinue: () => void
  /** Called when the user cancels (doesn't want to proceed). */
  onCancel: () => void
  /** Label for the continue button — "Continue" for upload, "Save Anyway" for save. */
  continueLabel?: string
}

export function DuplicateWarningModal({
  duplicates,
  onContinue,
  onCancel,
  continueLabel = 'Continue',
}: DuplicateWarningModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-50">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
            </div>
            <h3 className="text-base font-semibold text-gray-900">
              Possible Duplicate
            </h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <p className="text-sm text-gray-600 mb-4">
            {duplicates.length === 1
              ? 'A receipt with the same total and date already exists:'
              : `${duplicates.length} receipts with the same total and date already exist:`}
          </p>

          <div className="space-y-2">
            {duplicates.map(d => (
              <div
                key={d.id}
                className="flex items-center justify-between px-4 py-3 bg-amber-50 border border-amber-100 rounded-xl"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {d.store_name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {d.receipt_date}
                    <span className="mx-1.5 text-gray-300">·</span>
                    <span className={
                      d.status === 'verified'
                        ? 'text-green-600'
                        : 'text-amber-600'
                    }>
                      {d.status}
                    </span>
                  </p>
                </div>
                <span className="text-sm font-semibold text-gray-900 ml-3 shrink-0">
                  {d.total != null ? fmt(d.total) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onContinue}
            className="px-4 py-2 text-sm font-semibold text-white bg-[var(--tab-accent)] rounded-xl hover:bg-[var(--tab-accent-hover)] transition-colors"
          >
            {continueLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
