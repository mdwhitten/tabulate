import { useRef, useState, useMemo } from 'react'
import type { LineItem, Category } from '../types'
import type { NewLineItemBody } from '../types'
import { CategorySelect } from './CategorySelect'
import { PriceInput } from './PriceInput'
import { SourceTag } from './SourceTag'
import { EditItemModal } from './EditItemModal'
import { catColor, catIcon, fmt } from '../lib/utils'
import { ChevronRight, Plus, Trash2, Tag } from 'lucide-react'
import { useSwipeToDelete } from '../hooks/useSwipeToDelete'

/** A locally-created item (not yet saved) has a negative temp id */
export interface LocalItem {
  _tempId: number       // negative, for React key
  name: string
  price: number
  category: string
}

interface LineItemsTableProps {
  items: LineItem[]
  localItems: LocalItem[]
  categories: Category[]
  locked: boolean
  allowCategoryEdit?: boolean
  onCategoryChange:  (itemId: number, category: string) => void
  onPriceChange:     (itemId: number, newUnitPrice: number) => void
  onNameChange:      (itemId: number, newName: string) => void
  onDeleteItem:      (itemId: number) => void
  onAddItem:         (item: NewLineItemBody) => void
  onLocalItemChange: (tempId: number, patch: Partial<LocalItem>) => void
  onDeleteLocal:     (tempId: number) => void
}

/** Heuristic: price < 0 OR name starts with common discount prefix */
function isDiscount(item: LineItem): boolean {
  if (item.price < 0) return true
  const name = (item.clean_name || item.raw_name || '').toLowerCase()
  return /^(discount|coupon|savings|instant savings|member savings|rebate|credit|refund|reduction)/.test(name)
}

let _nextTempId = -1
export function nextTempId() { return _nextTempId-- }


// ── Swipeable DB item row ───────────────────────────────────────────────────

interface ItemRowProps {
  item: LineItem
  categories: Category[]
  locked: boolean
  allowCategoryEdit?: boolean
  onCategoryChange: (itemId: number, category: string) => void
  onPriceChange:    (itemId: number, newUnitPrice: number) => void
  onNameChange:     (itemId: number, newName: string) => void
  onDeleteItem:     (itemId: number) => void
}

function ItemRow({ item, categories, locked, allowCategoryEdit, onCategoryChange, onPriceChange, onNameChange, onDeleteItem }: ItemRowProps) {
  const { touchHandlers, rowStyle, isPastThreshold, offset } = useSwipeToDelete({
    onDelete: () => onDeleteItem(item.id),
    disabled: locked,
  })

  const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const showRaw   = item.clean_name && item.raw_name &&
    normalize(item.clean_name) !== normalize(item.raw_name)
  const lineTotal = item.price * item.quantity
  const discount  = isDiscount(item)

  const swiping = offset < -5
  const rowBg = discount ? 'bg-emerald-50' : 'bg-white'
  const swipeBg = isPastThreshold ? 'bg-red-500' : 'bg-red-400'

  // When swiping, cells get red background; content divs get opaque bg so the
  // red is only revealed in the gap created by the translateX slide.
  const cellSwipeClass = swiping ? swipeBg : ''
  const contentBgClass = swiping ? rowBg : ''

  return (
    <tr
      className={[
        'border-b border-gray-50 hover:bg-gray-50/70 transition-colors group',
        discount ? 'bg-emerald-50/60' : '',
      ].join(' ')}
      {...touchHandlers}
    >
      {/* Item name */}
      <td className={['px-0 py-0 align-middle', cellSwipeClass].join(' ')}>
        <div className={['px-2 py-2.5', contentBgClass].join(' ')} style={rowStyle}>
          {locked ? (
            <p className={['font-medium leading-tight', discount ? 'text-emerald-700' : 'text-gray-900'].join(' ')}>
              {item.clean_name || item.raw_name}
            </p>
          ) : (
            <input
              type="text"
              defaultValue={item.clean_name || item.raw_name}
              onBlur={e => {
                const v = e.target.value.trim()
                if (v && v !== (item.clean_name || item.raw_name)) onNameChange(item.id, v)
              }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className={[
                'font-medium leading-tight bg-transparent border-none outline-none w-full focus:bg-white focus:ring-1 focus:ring-blue-200 rounded px-0.5 -mx-0.5',
                discount ? 'text-emerald-700' : 'text-gray-900',
              ].join(' ')}
            />
          )}
          {showRaw && (
            <p className="text-[11px] text-gray-400 font-mono mt-0.5 truncate max-w-[160px]">
              {item.raw_name}
            </p>
          )}
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {discount && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded-full">
                <Tag className="w-2.5 h-2.5" />
                Discount
              </span>
            )}
            <SourceTag source={item.category_source} />
            {item.quantity > 1 && (
              <span className="text-[11px] text-gray-400 font-mono">
                ×{item.quantity} @ {fmt(item.price)}
              </span>
            )}
          </div>
        </div>
      </td>

      {/* Category */}
      <td className={['px-0 py-0 align-middle w-36', cellSwipeClass].join(' ')}>
        <div className={['px-2 py-2.5', contentBgClass].join(' ')} style={rowStyle}>
          <CategorySelect
            value={item.category}
            categories={categories}
            onChange={cat => onCategoryChange(item.id, cat)}
            disabled={locked && !allowCategoryEdit}
          />
        </div>
      </td>

      {/* Price — last visible cell gets the trash icon overlay */}
      <td className={['px-0 py-0 align-middle text-right relative', cellSwipeClass].join(' ')}>
        <div className={['px-2 py-2.5', contentBgClass].join(' ')} style={rowStyle}>
          <PriceInput
            lineTotal={lineTotal}
            locked={locked}
            negative={discount}
            onChange={newLineTotal => onPriceChange(item.id, newLineTotal / item.quantity)}
          />
        </div>
        {/* Trash icon pinned to right side of the red zone */}
        {swiping && (
          <div className="absolute inset-y-0 right-2 flex items-center pointer-events-none">
            <Trash2 className={[
              'w-5 h-5 text-white transition-transform',
              isPastThreshold ? 'scale-125' : '',
            ].join(' ')} />
          </div>
        )}
      </td>

      {/* Desktop-only delete button (hidden during swipe and on mobile) */}
      {!locked && (
        <td className={['px-1 py-2.5 align-middle hidden sm:table-cell', swiping ? 'invisible' : ''].join(' ')}>
          <button
            onClick={() => onDeleteItem(item.id)}
            title="Remove item"
            className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-300 hover:text-red-400 hover:bg-red-50 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </td>
      )}
    </tr>
  )
}


// ── Swipeable local (unsaved) item row ──────────────────────────────────────

interface LocalItemRowProps {
  loc: LocalItem
  categories: Category[]
  onLocalItemChange: (tempId: number, patch: Partial<LocalItem>) => void
  onDeleteLocal:     (tempId: number) => void
}

function LocalItemRow({ loc, categories, onLocalItemChange, onDeleteLocal }: LocalItemRowProps) {
  const { touchHandlers, rowStyle, isPastThreshold, offset } = useSwipeToDelete({
    onDelete: () => onDeleteLocal(loc._tempId),
  })

  const negLocal = loc.price < 0
  const swiping = offset < -5
  const rowBg = negLocal ? 'bg-emerald-50' : 'bg-blue-50'
  const swipeBg = isPastThreshold ? 'bg-red-500' : 'bg-red-400'
  const cellSwipeClass = swiping ? swipeBg : ''
  const contentBgClass = swiping ? rowBg : ''

  return (
    <tr
      className={[
        'border-b border-gray-50 group',
        negLocal ? 'bg-emerald-50/60' : 'bg-blue-50/40',
      ].join(' ')}
      {...touchHandlers}
    >
      <td className={['px-0 py-0 align-middle', cellSwipeClass].join(' ')}>
        <div className={['px-2 py-2.5', contentBgClass].join(' ')} style={rowStyle}>
          <input
            type="text"
            value={loc.name}
            onChange={e => onLocalItemChange(loc._tempId, { name: e.target.value })}
            placeholder="Item name"
            className={[
              'font-medium leading-tight bg-transparent border-none outline-none w-full focus:bg-white focus:ring-1 focus:ring-blue-200 rounded px-0.5 -mx-0.5',
              negLocal ? 'text-emerald-700' : 'text-gray-900',
            ].join(' ')}
          />
          <span className="text-[10px] text-blue-400 font-medium">new</span>
        </div>
      </td>
      <td className={['px-0 py-0 align-middle w-36', cellSwipeClass].join(' ')}>
        <div className={['px-2 py-2.5', contentBgClass].join(' ')} style={rowStyle}>
          <CategorySelect
            value={loc.category}
            categories={categories}
            onChange={cat => onLocalItemChange(loc._tempId, { category: cat })}
          />
        </div>
      </td>
      <td className={['px-0 py-0 align-middle text-right relative', cellSwipeClass].join(' ')}>
        <div className={['px-2 py-2.5', contentBgClass].join(' ')} style={rowStyle}>
          <PriceInput
            lineTotal={loc.price}
            locked={false}
            negative={negLocal}
            onChange={v => onLocalItemChange(loc._tempId, { price: v })}
          />
        </div>
        {swiping && (
          <div className="absolute inset-y-0 right-2 flex items-center pointer-events-none">
            <Trash2 className={[
              'w-5 h-5 text-white transition-transform',
              isPastThreshold ? 'scale-125' : '',
            ].join(' ')} />
          </div>
        )}
      </td>

      {/* Desktop-only delete button (hidden during swipe) */}
      <td className={['px-1 py-2.5 align-middle hidden sm:table-cell', swiping ? 'invisible' : ''].join(' ')}>
        <button
          onClick={() => onDeleteLocal(loc._tempId)}
          title="Remove item"
          className="p-1 rounded text-gray-300 hover:text-red-400 hover:bg-red-50 transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  )
}


// ── Mobile read-only card for DB items ─────────────────────────────────────

interface MobileItemCardProps {
  item: LineItem
  categories: Category[]
  locked: boolean
  onTap: () => void
  onDeleteItem: (id: number) => void
}

function MobileItemCard({ item, categories, locked, onTap, onDeleteItem }: MobileItemCardProps) {
  const { touchHandlers, rowStyle, isPastThreshold, offset } = useSwipeToDelete({
    onDelete: () => onDeleteItem(item.id),
    disabled: locked,
  })
  const discount = isDiscount(item)
  const lineTotal = item.price * item.quantity
  const icon = catIcon(item.category, categories)
  const color = catColor(item.category, categories)
  const swiping = offset < -5

  return (
    <div
      className={[
        'relative border-b border-gray-100 overflow-hidden',
        swiping ? (isPastThreshold ? 'bg-red-500' : 'bg-red-400') : '',
      ].join(' ')}
      {...touchHandlers}
    >
      <div
        className={[
          'flex items-center gap-3 px-3 py-3 active:bg-gray-50 transition-colors',
          discount ? 'bg-emerald-50/60' : 'bg-white',
        ].join(' ')}
        style={rowStyle}
        onClick={() => { if (!swiping) onTap() }}
      >
        {/* Category color dot */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
          style={{ backgroundColor: color + '18' }}
        >
          {icon}
        </div>

        {/* Item info */}
        <div className="flex-1 min-w-0">
          <p className={[
            'font-medium text-sm leading-tight truncate',
            discount ? 'text-emerald-700' : 'text-gray-900',
          ].join(' ')}>
            {item.clean_name || item.raw_name}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-gray-400 truncate">{item.category}</span>
            {discount && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600 bg-emerald-100 px-1 py-0.5 rounded-full">
                <Tag className="w-2.5 h-2.5" />
              </span>
            )}
            <SourceTag source={item.category_source} />
            {item.quantity > 1 && (
              <span className="text-[10px] text-gray-400 font-mono">x{item.quantity}</span>
            )}
          </div>
        </div>

        {/* Price + chevron */}
        <div className="flex items-center gap-1 shrink-0">
          <span className={[
            'font-mono font-medium text-sm tabular-nums',
            discount ? 'text-emerald-600' : 'text-gray-900',
          ].join(' ')}>
            {discount ? '-' : ''}{fmt(Math.abs(lineTotal))}
          </span>
          {!locked && <ChevronRight className="w-4 h-4 text-gray-300" />}
        </div>
      </div>

      {/* Swipe-to-delete indicator */}
      {swiping && (
        <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
          <Trash2 className={[
            'w-5 h-5 text-white transition-transform',
            isPastThreshold ? 'scale-125' : '',
          ].join(' ')} />
        </div>
      )}
    </div>
  )
}


// ── Mobile read-only card for local (unsaved) items ────────────────────────

interface MobileLocalCardProps {
  loc: LocalItem
  categories: Category[]
  onTap: () => void
  onDeleteLocal: (tempId: number) => void
}

function MobileLocalCard({ loc, categories, onTap, onDeleteLocal }: MobileLocalCardProps) {
  const { touchHandlers, rowStyle, isPastThreshold, offset } = useSwipeToDelete({
    onDelete: () => onDeleteLocal(loc._tempId),
  })
  const negLocal = loc.price < 0
  const icon = catIcon(loc.category, categories)
  const color = catColor(loc.category, categories)
  const swiping = offset < -5

  return (
    <div
      className={[
        'relative border-b border-gray-100 overflow-hidden',
        swiping ? (isPastThreshold ? 'bg-red-500' : 'bg-red-400') : '',
      ].join(' ')}
      {...touchHandlers}
    >
      <div
        className={[
          'flex items-center gap-3 px-3 py-3 active:bg-gray-50 transition-colors',
          negLocal ? 'bg-emerald-50/60' : 'bg-blue-50/40',
        ].join(' ')}
        style={rowStyle}
        onClick={() => { if (!swiping) onTap() }}
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
          style={{ backgroundColor: color + '18' }}
        >
          {icon}
        </div>

        <div className="flex-1 min-w-0">
          <p className={[
            'font-medium text-sm leading-tight truncate',
            negLocal ? 'text-emerald-700' : 'text-gray-900',
          ].join(' ')}>
            {loc.name || 'Unnamed item'}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-gray-400 truncate">{loc.category}</span>
            <span className="text-[10px] text-blue-500 font-semibold uppercase bg-blue-50 px-1 py-0.5 rounded">new</span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className={[
            'font-mono font-medium text-sm tabular-nums',
            negLocal ? 'text-emerald-600' : 'text-gray-900',
          ].join(' ')}>
            {negLocal ? '-' : ''}{fmt(Math.abs(loc.price))}
          </span>
          <ChevronRight className="w-4 h-4 text-gray-300" />
        </div>
      </div>

      {swiping && (
        <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
          <Trash2 className={[
            'w-5 h-5 text-white transition-transform',
            isPastThreshold ? 'scale-125' : '',
          ].join(' ')} />
        </div>
      )}
    </div>
  )
}


// ── Main table ──────────────────────────────────────────────────────────────

export function LineItemsTable({
  items,
  localItems,
  categories,
  locked,
  allowCategoryEdit,
  onCategoryChange,
  onPriceChange,
  onNameChange,
  onDeleteItem,
  onAddItem,
  onLocalItemChange,
  onDeleteLocal,
}: LineItemsTableProps) {
  const subtotal = useMemo(
    () => items.reduce((s, i) => s + i.price * i.quantity, 0)
        + localItems.reduce((s, i) => s + i.price, 0),
    [items, localItems]
  )

  // Modal state for mobile editing
  const [editingItem, setEditingItem] = useState<LineItem | null>(null)
  const [editingLocal, setEditingLocal] = useState<LocalItem | null>(null)

  // Inline-add row state
  const [addName, setAddName]   = useState('')
  const [addPrice, setAddPrice] = useState('')
  const [addCat, setAddCat]     = useState(categories[0]?.name ?? 'Other')
  const [addingRow, setAddingRow] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  function openAddRow() {
    setAddName('')
    setAddPrice('')
    setAddCat(categories.find(c => c.name === 'Other')?.name ?? categories[0]?.name ?? 'Other')
    setAddingRow(true)
    setTimeout(() => nameInputRef.current?.focus(), 50)
  }

  function commitAdd() {
    const price = parseFloat(addPrice)
    if (!addName.trim() || isNaN(price)) { setAddingRow(false); return }
    onAddItem({ name: addName.trim(), price, category: addCat })
    setAddingRow(false)
  }

  function addRowKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
    if (e.key === 'Escape') { e.preventDefault(); setAddingRow(false) }
  }

  return (
    <>
      {/* ── Mobile card list (< 640px) ─────────────────────────────────────── */}
      <div className="sm:hidden">
        <div className="rounded-xl border border-gray-100 overflow-hidden bg-white">
          {items.map(item => (
            <MobileItemCard
              key={item.id}
              item={item}
              categories={categories}
              locked={locked}
              onTap={() => { if (!locked) setEditingItem(item) }}
              onDeleteItem={onDeleteItem}
            />
          ))}

          {localItems.map(loc => (
            <MobileLocalCard
              key={loc._tempId}
              loc={loc}
              categories={categories}
              onTap={() => setEditingLocal(loc)}
              onDeleteLocal={onDeleteLocal}
            />
          ))}
        </div>

        {/* Add item + subtotal footer */}
        <div className="mt-2 space-y-2">
          {!locked && (
            <button
              onClick={openAddRow}
              className="flex items-center gap-1.5 text-xs text-[#03a9f4] hover:text-[#0290d1] font-medium transition-colors px-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add item
            </button>
          )}
          <div className="flex items-center justify-between px-3 py-3 border-t-2 border-gray-200">
            <span className="font-semibold text-gray-700">Subtotal</span>
            <span className="font-mono font-semibold text-gray-900 tabular-nums">{fmt(subtotal)}</span>
          </div>
        </div>
      </div>

      {/* ── Desktop table (>= 640px) ───────────────────────────────────────── */}
      <div className="hidden sm:block overflow-x-auto overflow-y-visible">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-[11px] uppercase tracking-wider text-gray-400 font-medium px-2 py-2">
                Item
              </th>
              <th className="text-left text-[11px] uppercase tracking-wider text-gray-400 font-medium px-2 py-2">
                Category
              </th>
              <th className="text-right text-[11px] uppercase tracking-wider text-gray-400 font-medium px-2 py-2">
                Price
              </th>
              {!locked && (
                <th className="w-6 px-1 py-2" />
              )}
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <ItemRow
                key={item.id}
                item={item}
                categories={categories}
                locked={locked}
                allowCategoryEdit={allowCategoryEdit}
                onCategoryChange={onCategoryChange}
                onPriceChange={onPriceChange}
                onNameChange={onNameChange}
                onDeleteItem={onDeleteItem}
              />
            ))}

            {/* Locally added items (not yet saved) */}
            {localItems.map(loc => (
              <LocalItemRow
                key={loc._tempId}
                loc={loc}
                categories={categories}
                onLocalItemChange={onLocalItemChange}
                onDeleteLocal={onDeleteLocal}
              />
            ))}

            {/* Inline add row */}
            {addingRow && (
              <tr className="border-b border-blue-100 bg-blue-50/60">
                <td className="px-2 py-2 align-middle">
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    onKeyDown={addRowKeyDown}
                    placeholder="Item name"
                    className="w-full text-sm font-medium text-gray-900 bg-white border border-blue-200 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </td>
                <td className="px-2 py-2 align-middle w-36">
                  <CategorySelect
                    value={addCat}
                    categories={categories}
                    onChange={setAddCat}
                  />
                </td>
                <td className="px-2 py-2 align-middle text-right">
                  <input
                    type="number"
                    step="0.01"
                    value={addPrice}
                    onChange={e => setAddPrice(e.target.value)}
                    onKeyDown={addRowKeyDown}
                    placeholder="0.00"
                    className="w-20 text-sm font-mono text-right text-gray-900 bg-white border border-blue-200 rounded px-2 py-1 outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </td>
                <td className="px-1 py-2 align-middle">
                  <button onClick={() => setAddingRow(false)} title="Cancel"
                    className="p-1 rounded text-gray-300 hover:text-red-400 hover:bg-red-50 transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            {!locked && (
              <tr>
                <td colSpan={4} className="px-2 py-1.5">
                  <button
                    onClick={openAddRow}
                    className="flex items-center gap-1.5 text-xs text-[#03a9f4] hover:text-[#0290d1] font-medium transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add item
                  </button>
                </td>
              </tr>
            )}
            <tr className="border-t-2 border-gray-200">
              <td className="px-2 py-3 font-semibold text-gray-700">Subtotal</td>
              <td />
              <td className="px-2 py-3 text-right font-mono font-semibold text-gray-900 tabular-nums">
                {fmt(subtotal)}
              </td>
              {!locked && <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Edit modal (mobile) ────────────────────────────────────────────── */}
      {editingItem && (
        <EditItemModal
          item={editingItem}
          categories={categories}
          onNameChange={onNameChange}
          onCategoryChange={onCategoryChange}
          onPriceChange={(id, unitPrice) => onPriceChange(id, unitPrice)}
          onDeleteItem={onDeleteItem}
          onClose={() => setEditingItem(null)}
        />
      )}
      {editingLocal && (
        <EditItemModal
          localItem={editingLocal}
          categories={categories}
          onLocalItemChange={onLocalItemChange}
          onDeleteLocal={onDeleteLocal}
          onClose={() => setEditingLocal(null)}
        />
      )}
    </>
  )
}
