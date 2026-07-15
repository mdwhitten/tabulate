import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

export interface SelectOption {
  value: string
  label: string
  /** Optional muted suffix (e.g. "(closed)") */
  hint?: string
}

export interface SelectOptionGroup {
  label: string
  options: SelectOption[]
}

interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[] | SelectOptionGroup[]
  /** Shown on the button when no value is selected */
  placeholder?: string
  /** When set, adds an always-present row that clears the value (value = ''), e.g. "— Default —" */
  emptyLabel?: string
  disabled?: boolean
  searchPlaceholder?: string
  /** Minimum number of options before the search box appears (default 5) */
  searchThreshold?: number
  className?: string
}

const DROP_HEIGHT = 280
const GAP = 4

function isGrouped(options: SelectOption[] | SelectOptionGroup[]): options is SelectOptionGroup[] {
  return options.length > 0 && 'options' in options[0]
}

export function SearchableSelect({
  value, onChange, options, placeholder = 'Select…', emptyLabel,
  disabled, searchPlaceholder = 'Search…', searchThreshold = 5, className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const groups: SelectOptionGroup[] = isGrouped(options)
    ? options
    : [{ label: '', options: options as SelectOption[] }]

  const allOptions = groups.flatMap(g => g.options)
  const selected = allOptions.find(o => o.value === value)

  const calcPos = useCallback(() => {
    if (!btnRef.current) return null
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - GAP
    const top = spaceBelow >= DROP_HEIGHT ? r.bottom + GAP : r.top - GAP - DROP_HEIGHT
    return { top, left: r.left, width: Math.max(r.width, 220) }
  }, [])

  function handleOpen() {
    if (disabled) return
    if (open) { setOpen(false); setPos(null); setSearch(''); return }
    setPos(calcPos())
    setSearch('')
    setOpen(true)
  }

  function handleSelect(v: string) {
    onChange(v)
    setOpen(false)
    setPos(null)
    setSearch('')
  }

  // Focus the search box when opened
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  // Close on outside click; reposition on scroll
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (btnRef.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false); setPos(null); setSearch('')
    }
    function handleScroll() { setPos(calcPos()) }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, calcPos])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setPos(null); setSearch('') }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const q = search.toLowerCase().trim()
  const filteredGroups = groups
    .map(g => ({ label: g.label, options: q ? g.options.filter(o => o.label.toLowerCase().includes(q)) : g.options }))
    .filter(g => g.options.length > 0)
  const showEmpty = emptyLabel != null && (!q || emptyLabel.toLowerCase().includes(q))

  return (
    <div className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={cn(
          'w-full min-w-[200px] flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 transition-all',
          'hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span className={cn('flex-1 text-left truncate text-sm', selected ? 'text-gray-800' : 'text-gray-400')}>
          {selected ? selected.label : (value === '' && emptyLabel ? emptyLabel : placeholder)}
        </span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col"
        >
          {allOptions.length > searchThreshold && (
            <div className="p-2 pb-0 flex-shrink-0">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]"
              />
            </div>
          )}

          <div className="p-1.5 overflow-y-auto" style={{ maxHeight: DROP_HEIGHT }}>
            {showEmpty && (
              <button
                type="button"
                onClick={() => handleSelect('')}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                  value === '' ? 'bg-blue-50' : 'hover:bg-gray-50',
                )}
              >
                <span className={cn('flex-1 text-sm truncate italic', value === '' ? 'font-semibold text-gray-900' : 'text-gray-500')}>
                  {emptyLabel}
                </span>
                {value === '' && <Check className="w-3.5 h-3.5 text-[#03a9f4] shrink-0" />}
              </button>
            )}

            {filteredGroups.length === 0 && !showEmpty ? (
              <div className="text-xs text-gray-400 text-center py-4">No matches</div>
            ) : (
              filteredGroups.map(g => (
                <div key={g.label || '_'}>
                  {g.label && (
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold px-2.5 pt-2 pb-1">
                      {g.label}
                    </div>
                  )}
                  {g.options.map(o => {
                    const isSel = o.value === value
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => handleSelect(o.value)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                          isSel ? 'bg-blue-50' : 'hover:bg-gray-50',
                        )}
                      >
                        <span className={cn('flex-1 text-sm truncate', isSel ? 'font-semibold text-gray-900' : 'text-gray-700')}>
                          {o.label}
                          {o.hint && <span className="text-gray-400 font-normal"> {o.hint}</span>}
                        </span>
                        {isSel && <Check className="w-3.5 h-3.5 text-[#03a9f4] shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
