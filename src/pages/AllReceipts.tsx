import { useState } from 'react'
import { Search, Loader2, Trash2 } from 'lucide-react'
import { useReceiptList, useDeleteReceipt } from '../hooks/useReceipts'
import { storeIcon, fmt } from '../lib/utils'
import { Badge } from '../components/Badge'
import type { ReceiptSummary } from '../types'

interface AllReceiptsProps {
  onOpenReceipt: (id: number) => void
}

const STATUS_FILTERS = ['All', 'Approved', 'Pending'] as const
type StatusFilter = typeof STATUS_FILTERS[number]

export function AllReceipts({ onOpenReceipt }: AllReceiptsProps) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('All')

  const { data: receipts = [], isLoading, isError } = useReceiptList()

  const filtered = receipts.filter(r => {
    const matchSearch = !search ||
      r.store_name?.toLowerCase().includes(search.toLowerCase()) ||
      r.receipt_date?.includes(search)
    const matchStatus =
      status === 'All' ||
      (status === 'Approved' && r.status === 'verified') ||
      (status === 'Pending'  && r.status !== 'verified')
    return matchSearch && matchStatus
  })

  return (
    <div className="space-y-4 max-w-5xl">

      {/* Filter toolbar */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-4 py-3 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search store or date…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4] transition-all placeholder:text-gray-400"
          />
        </div>

        {/* Status filter chips */}
        <div className="flex items-center gap-1.5 bg-gray-100 rounded-xl p-1">
          {STATUS_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                status === f
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <span className="text-xs text-gray-400 ml-auto">
          {isLoading ? '…' : `${filtered.length} receipt${filtered.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Table card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
        {isLoading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading receipts…</span>
          </div>
        ) : isError ? (
          <div className="py-16 text-center">
            <p className="text-sm font-semibold text-red-500 mb-1">Failed to load receipts</p>
            <p className="text-xs text-gray-400">Check that the backend is running</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-4xl mb-3">🧾</p>
            <p className="text-sm font-semibold text-gray-700 mb-1">No receipts found</p>
            <p className="text-xs text-gray-400">Try adjusting your search or filters</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-5 py-3">Store</th>
                <th className="text-left text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-4 py-3 hidden sm:table-cell">Date</th>
                <th className="text-center text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-4 py-3 hidden md:table-cell">Items</th>
                <th className="text-right text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-4 py-3">Total</th>
                <th className="text-right text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-5 py-3">Status</th>
                <th className="w-10 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <ReceiptTableRow
                  key={r.id}
                  receipt={r}
                  index={i}
                  onClick={() => onOpenReceipt(r.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function ReceiptTableRow({
  receipt: r,
  index,
  onClick,
}: {
  receipt: ReceiptSummary
  index: number
  onClick: () => void
}) {
  const deleteReceipt = useDeleteReceipt()

  const date = r.receipt_date
    ? new Date(r.receipt_date + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : '—'

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (confirm(`Delete receipt from ${r.store_name ?? 'Unknown'}?`)) {
      deleteReceipt.mutate(r.id)
    }
  }

  return (
    <tr
      onClick={onClick}
      className="border-b border-gray-50 last:border-0 hover:bg-[#03a9f4]/5 cursor-pointer transition-colors group"
      style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
    >
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center text-base shrink-0 group-hover:bg-gray-200 transition-colors">
            {storeIcon(r.store_name)}
          </div>
          <span className="text-sm font-medium text-gray-900">{r.store_name ?? 'Unknown'}</span>
        </div>
      </td>
      <td className="px-4 py-3.5 hidden sm:table-cell">
        <span className="text-sm text-gray-500">{date}</span>
      </td>
      <td className="px-4 py-3.5 text-center hidden md:table-cell">
        <span className="text-xs font-mono text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
          ×{r.item_count}
        </span>
      </td>
      <td className="px-4 py-3.5 text-right">
        <span className="text-sm font-mono font-semibold text-gray-800 tabular-nums">
          {r.total != null ? fmt(r.total) : '—'}
        </span>
      </td>
      <td className="px-5 py-3.5 text-right">
        <Badge variant={r.status === 'verified' ? 'verified' : r.status === 'review' ? 'review' : 'pending'} />
      </td>
      <td className="pr-3 py-3.5 text-right">
        <button
          onClick={handleDelete}
          title="Delete receipt"
          className="p-1.5 rounded-lg text-gray-300 hover:text-red-400 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  )
}
