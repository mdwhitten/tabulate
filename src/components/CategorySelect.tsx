import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn, catColor, catIcon } from '../lib/utils'
import type { Category } from '../types'

interface CategorySelectProps {
  value: string
  categories: Category[]
  onChange: (cat: string) => void
  disabled?: boolean
  /** Render a larger variant (used in modals) */
  size?: 'sm' | 'lg'
}

const DROP_HEIGHT = 280
const GAP = 4

export function CategorySelect({ value, categories, onChange, disabled, size = 'sm' }: CategorySelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const color = catColor(value, categories)
  const icon = catIcon(value, categories)

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

  function handleSelect(name: string) {
    onChange(name)
    setOpen(false)
    setPos(null)
    setSearch('')
  }

  // Close on outside click
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

  const filtered = search.trim()
    ? categories.filter(c => c.name.toLowerCase().includes(search.toLowerCase().trim()))
    : categories

  const isLg = size === 'lg'

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={cn(
          'w-full flex items-center gap-2 rounded-md border border-gray-200 bg-white transition-all',
          'hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent',
          'disabled:cursor-default disabled:opacity-70',
          isLg ? 'px-4 py-3 rounded-xl' : 'px-2.5 py-1.5',
        )}
        style={{ borderLeftWidth: 3, borderLeftColor: color }}
      >
        <span className={isLg ? 'text-base' : 'text-xs'}>{icon}</span>
        <span className={cn(
          'flex-1 text-left truncate font-medium text-gray-800',
          isLg ? 'text-base' : 'text-xs',
        )}>
          {value}
        </span>
        <ChevronDown className={cn(
          'text-gray-400 shrink-0 transition-transform',
          isLg ? 'w-4 h-4' : 'w-3 h-3',
          open && 'rotate-180',
        )} />
      </button>

      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col"
        >
          {/* Search */}
          {categories.length > 5 && (
            <div className="p-2 pb-0 flex-shrink-0">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search categories…"
                className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#03a9f4]/30 focus:border-[#03a9f4]"
              />
            </div>
          )}

          {/* Category list */}
          <div className="p-1.5 overflow-y-auto" style={{ maxHeight: DROP_HEIGHT }}>
            {filtered.length === 0 ? (
              <div className="text-xs text-gray-400 text-center py-4">No categories found</div>
            ) : (
              filtered.map(c => {
                const selected = c.name === value
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleSelect(c.name)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                      selected ? 'bg-blue-50' : 'hover:bg-gray-50',
                    )}
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="text-sm">{c.icon}</span>
                    <span className={cn(
                      'flex-1 text-sm truncate',
                      selected ? 'font-semibold text-gray-900' : 'text-gray-700',
                    )}>
                      {c.name}
                    </span>
                    {selected && <Check className="w-3.5 h-3.5 text-[#03a9f4] shrink-0" />}
                  </button>
                )
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
