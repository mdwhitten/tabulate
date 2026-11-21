import { storeIcon, fmt, relativeTime } from '../lib/utils'
import { Badge } from './Badge'
import { receiptDisplayName, receiptStatusNote, statusVariant } from '../lib/receiptFilter'
import type { ReceiptSummary } from '../types'

interface ReceiptRowProps {
  receipt: ReceiptSummary
  onClick: () => void
}

export function ReceiptRow({ receipt, onClick }: ReceiptRowProps) {
  const date = receipt.receipt_date
    ? new Date(receipt.receipt_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : relativeTime(receipt.scanned_at)

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-all hover:-translate-y-px rounded-xl group text-left"
    >
      {/* Store icon */}
      <div className="w-9 h-9 bg-gray-100 rounded-xl flex items-center justify-center text-lg shrink-0 group-hover:bg-gray-200 transition-colors">
        {storeIcon(receipt.store_name)}
      </div>

      {/* Name + date */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">
          {receiptDisplayName(receipt)}
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          {date} · {receiptStatusNote(receipt) ?? `${receipt.item_count} items`}
        </p>
      </div>

      {/* Total + badge */}
      <div className="flex items-center gap-3 shrink-0">
        <Badge variant={statusVariant(receipt.status)} />
        <span className="text-sm font-mono font-semibold text-gray-800 tabular-nums w-16 text-right">
          {receipt.total != null ? fmt(receipt.total) : '—'}
        </span>
      </div>
    </button>
  )
}
