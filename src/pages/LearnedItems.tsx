import { useState } from 'react'
import { Search, Loader2, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { useMappingList, useUpdateMappingCategory, useDeleteMapping } from '../hooks/useMappings'
import { useCategoryList } from '../hooks/useCategories'
import { useSwipeToDelete } from '../hooks/useSwipeToDelete'
import { catColor, catIcon, relativeTime } from '../lib/utils'
import { SourceTag } from '../components/SourceTag'
import { CategorySelect } from '../components/CategorySelect'
import type { ItemMapping } from '../types'

const PAGE_SIZE = 50

export function LearnedItems() {
  const { data: categories = [] } = useCategoryList()
  const updateCat = useUpdateMappingCategory()
  const deleteMut = useDeleteMapping()

  const [search, setSearch]       = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [page, setPage]           = useState(0)

  // Debounce search to avoid hammering the API on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

  function handleSearchChange(value: string) {
    setSearch(value)
    if (debounceTimer) clearTimeout(debounceTimer)
    setDebounceTimer(setTimeout(() => {
      setDebouncedSearch(value)
      setPage(0)
    }, 300))
  }

  function handleCatFilter(cat: string) {
    setCatFilter(cat)
    setPage(0)
  }

  const { data, isLoading, isError, isFetching } = useMappingList({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    search: debouncedSearch || undefined,
    category: catFilter || undefined,
  })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const catNames = ['', ...categories.filter(c => !c.is_disabled).map(c => c.name)]

  function handleCategoryChange(id: number, category: string) {
    updateCat.mutate({ id, category })
  }

  function handleDelete(id: number) {
    deleteMut.mutate(id)
  }

  return (
    <div className="space-y-4 max-w-5xl">

      {/* Filter toolbar */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input type="text" placeholder="Search items…" value={search}
            onChange={e => handleSearchChange(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4] transition-all placeholder:text-gray-400" />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {catNames.map(cat => (
            <button key={cat || '__all'} onClick={() => handleCatFilter(cat)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                catFilter === cat
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'
              }`}>
              {cat && (
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: catColor(cat, categories) }} />
              )}
              {cat ? catIcon(cat, categories) + ' ' + cat : 'All'}
            </button>
          ))}
        </div>

        <span className="text-xs text-gray-400 ml-auto whitespace-nowrap">
          {isLoading ? '…' : `${total} rule${total !== 1 ? 's' : ''}`}
          {isFetching && !isLoading && <Loader2 className="w-3 h-3 animate-spin inline ml-1" />}
        </span>
      </div>

      {/* Table card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
        {isLoading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading learned items…</span>
          </div>
        ) : isError ? (
          <div className="py-16 text-center">
            <p className="text-sm font-semibold text-red-500 mb-1">Failed to load learned items</p>
            <p className="text-xs text-gray-400">Check that the backend is running</p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-4xl mb-3">📚</p>
            <p className="text-sm font-semibold text-gray-700 mb-1">No learned items found</p>
            <p className="text-xs text-gray-400">Save receipts and correct categories to build up rules</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/60">
                <th className="text-left text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-5 py-3">Item</th>
                <th className="text-left text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-4 py-3 hidden lg:table-cell">Raw OCR Key</th>
                <th className="text-left text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-4 py-3">Category</th>
                <th className="text-center text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-3 py-3 hidden md:table-cell">Seen</th>
                <th className="text-left text-[11px] uppercase tracking-widest text-gray-400 font-semibold px-4 py-3 hidden sm:table-cell">Last Seen</th>
                <th className="w-10 py-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((m, i) => (
                <LearnedItemRow key={m.id} mapping={m} index={i} categories={categories}
                  onCategoryChange={cat => handleCategoryChange(m.id, cat)}
                  onDelete={() => handleDelete(m.id)} />
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/40">
            <span className="text-xs text-gray-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(p => p - 1)} disabled={page === 0}
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-medium text-gray-600 px-2 tabular-nums">
                {page + 1} / {totalPages}
              </span>
              <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 px-1">
        Learned rules are applied automatically when the same item is scanned again. Changing a category here updates future receipts only.
      </p>
    </div>
  )
}

interface RowProps {
  mapping: ItemMapping
  index: number
  categories: import('../types').Category[]
  onCategoryChange: (cat: string) => void
  onDelete: () => void
}

function LearnedItemRow({ mapping: m, index, categories, onCategoryChange, onDelete }: RowProps) {
  const { touchHandlers, rowStyle, isPastThreshold, offset } = useSwipeToDelete({
    onDelete,
  })

  const swiping = offset < -5

  return (
    <tr className="border-b border-gray-50 last:border-0 hover:bg-gray-50/70 transition-colors group"
      style={{ animationDelay: `${Math.min(index, 9) * 25}ms` }}
      {...touchHandlers}>

      <td className="px-0 py-0 overflow-hidden">
        <div className="px-5 py-3" style={rowStyle}>
          <p className="text-sm font-medium text-gray-900 leading-tight">{m.display_name}</p>
          <div className="mt-1">
            <SourceTag source={m.source} />
          </div>
        </div>
      </td>

      <td className="px-0 py-0 hidden lg:table-cell overflow-hidden">
        <div className="px-4 py-3" style={rowStyle}>
          <span className="text-[11px] font-mono text-gray-400 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 max-w-[180px] truncate block">
            {m.normalized_key}
          </span>
        </div>
      </td>

      <td className="px-0 py-0 overflow-hidden">
        <div className="px-4 py-3" style={rowStyle}>
          <CategorySelect value={m.category} categories={categories} onChange={onCategoryChange} />
        </div>
      </td>

      <td className="px-0 py-0 text-center hidden md:table-cell overflow-hidden">
        <div className="px-3 py-3" style={rowStyle}>
          <span className="text-xs font-mono font-medium text-gray-600 bg-gray-100 rounded-full px-2 py-0.5 tabular-nums">
            ×{m.times_seen}
          </span>
        </div>
      </td>

      <td className="px-0 py-0 hidden sm:table-cell overflow-hidden">
        <div className="px-4 py-3" style={rowStyle}>
          <span className="text-xs text-gray-400">{relativeTime(m.last_seen)}</span>
        </div>
      </td>

      {/* Delete action — swipe indicator (touch) + hover button (pointer) */}
      <td className={['px-0 py-0 relative', swiping ? (isPastThreshold ? 'bg-red-500' : 'bg-red-400') : ''].join(' ')}>
        <div className="w-10" style={rowStyle} />
        {swiping ? (
          <div className="absolute inset-y-0 right-1 flex items-center pointer-events-none">
            <Trash2 className={[
              'w-5 h-5 text-white transition-transform',
              isPastThreshold ? 'scale-125' : '',
            ].join(' ')} />
          </div>
        ) : (
          <div className="absolute inset-y-0 right-1 flex items-center">
            <button
              onClick={onDelete}
              title="Delete rule"
              className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-300 hover:text-red-400 hover:bg-red-50 transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}
