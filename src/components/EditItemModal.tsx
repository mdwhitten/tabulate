import { useState, useEffect, useRef } from 'react'
import type { LineItem, Category } from '../types'
import type { LocalItem } from './LineItemsTable'
import { CategorySelect } from './CategorySelect'
import { SourceTag } from './SourceTag'
import { catIcon, fmt } from '../lib/utils'
import { Trash2, X } from 'lucide-react'

interface EditItemModalProps {
  /** DB item being edited (mutually exclusive with localItem) */
  item?: LineItem | null
  /** Unsaved local item being edited */
  localItem?: LocalItem | null
  categories: Category[]
  onNameChange?: (id: number, name: string) => void
  onCategoryChange?: (id: number, category: string) => void
  onPriceChange?: (id: number, unitPrice: number) => void
  onDeleteItem?: (id: number) => void
  onLocalItemChange?: (tempId: number, patch: Partial<LocalItem>) => void
  onDeleteLocal?: (tempId: number) => void
  onClose: () => void
}

export function EditItemModal({
  item,
  localItem,
  categories,
  onNameChange,
  onCategoryChange,
  onPriceChange,
  onDeleteItem,
  onLocalItemChange,
  onDeleteLocal,
  onClose,
}: EditItemModalProps) {
  const isLocal = !!localItem
  const initialName = isLocal
    ? localItem!.name
    : (item!.clean_name || item!.raw_name)
  const initialCategory = isLocal ? localItem!.category : item!.category
  const initialPrice = isLocal ? localItem!.price : item!.price
  const quantity = isLocal ? 1 : item!.quantity

  const [name, setName] = useState(initialName)
  const [category, setCategory] = useState(initialCategory)
  const [priceStr, setPriceStr] = useState(Math.abs(initialPrice).toFixed(2))
  const [isNegative] = useState(initialPrice < 0)

  const backdropRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Focus name input on mount
  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 100)
  }, [])

  function handleDone() {
    const priceVal = parseFloat(priceStr)
    const finalPrice = isNaN(priceVal) ? Math.abs(initialPrice) : priceVal
    const signedPrice = isNegative ? -finalPrice : finalPrice

    if (isLocal) {
      const patch: Partial<LocalItem> = {}
      if (name.trim() !== localItem!.name) patch.name = name.trim()
      if (category !== localItem!.category) patch.category = category
      if (signedPrice !== localItem!.price) patch.price = signedPrice
      if (Object.keys(patch).length > 0) {
        onLocalItemChange?.(localItem!._tempId, patch)
      }
    } else {
      const trimmed = name.trim()
      if (trimmed && trimmed !== initialName) onNameChange?.(item!.id, trimmed)
      if (category !== initialCategory) onCategoryChange?.(item!.id, category)
      if (signedPrice !== initialPrice) {
        // onPriceChange expects unit price (line total / quantity)
        onPriceChange?.(item!.id, signedPrice / quantity)
      }
    }
    onClose()
  }

  function handleDelete() {
    if (isLocal) {
      onDeleteLocal?.(localItem!._tempId)
    } else {
      onDeleteItem?.(item!.id)
    }
    onClose()
  }

  const icon = catIcon(category, categories)
  const rawName = !isLocal && item!.raw_name && item!.clean_name
    && item!.raw_name.replace(/\s+/g, '').toLowerCase() !== item!.clean_name.replace(/\s+/g, '').toLowerCase()
    ? item!.raw_name
    : null

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === backdropRef.current) onClose() }}
    >
      <div className="bg-white w-full max-w-lg rounded-t-2xl shadow-2xl animate-slide-up safe-bottom">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span className="text-xl">{icon}</span>
            Edit Item
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 pb-2 space-y-4">
          {/* Item name */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Item Name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleDone() }}
              className="w-full text-base font-medium text-gray-900 border border-gray-200 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition-shadow"
            />
            {rawName && (
              <p className="text-xs text-gray-400 font-mono mt-1.5 px-1">
                raw: {rawName}
              </p>
            )}
            <div className="flex items-center gap-2 mt-1.5 px-1">
              {isLocal && (
                <span className="text-[10px] text-blue-500 font-semibold uppercase bg-blue-50 px-1.5 py-0.5 rounded">new</span>
              )}
              {!isLocal && <SourceTag source={item!.category_source} />}
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Category
            </label>
            <div className="[&_select]:!text-base [&_select]:!py-3 [&_select]:!rounded-xl">
              <CategorySelect
                value={category}
                categories={categories}
                onChange={setCategory}
              />
            </div>
          </div>

          {/* Price */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Price
            </label>
            <div className="flex items-center gap-3">
              <div className="inline-flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-blue-300 focus-within:border-transparent transition-shadow">
                <span className={[
                  'px-3 py-3 bg-gray-50 border-r border-gray-200 text-sm font-mono select-none',
                  isNegative ? 'text-emerald-500' : 'text-gray-400',
                ].join(' ')}>
                  {isNegative ? '-$' : '$'}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={priceStr}
                  onFocus={e => e.target.select()}
                  onChange={e => setPriceStr(e.target.value)}
                  onBlur={() => {
                    const n = parseFloat(priceStr)
                    if (!isNaN(n) && n >= 0) setPriceStr(n.toFixed(2))
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') handleDone() }}
                  className="w-24 px-3 py-3 text-base font-mono font-medium text-right bg-white outline-none tabular-nums"
                />
              </div>
              {quantity > 1 && (
                <span className="text-sm text-gray-500 font-mono">
                  x{quantity} = {fmt(parseFloat(priceStr || '0') * quantity)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pt-3 pb-5 space-y-3">
          <button
            onClick={handleDone}
            className="w-full py-3.5 bg-[#03a9f4] text-white text-base font-semibold rounded-xl hover:bg-[#0290d1] active:bg-[#0277a8] transition-colors"
          >
            Done
          </button>
          <button
            onClick={handleDelete}
            className="w-full flex items-center justify-center gap-2 py-2.5 text-red-500 text-sm font-medium hover:bg-red-50 rounded-xl transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Delete item
          </button>
        </div>
      </div>
    </div>
  )
}
