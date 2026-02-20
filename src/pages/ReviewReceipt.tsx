import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { CalendarDays, Store, X, RotateCcw, Save, Trash2 } from 'lucide-react'
import type { Receipt, Category, SaveReceiptBody, NewLineItemBody } from '../types'
import { Badge } from '../components/Badge'
import { VerifyBar } from '../components/VerifyBar'
import { LineItemsTable } from '../components/LineItemsTable'
import type { LocalItem } from '../components/LineItemsTable'
import { nextTempId } from '../components/LineItemsTable'
import { ReceiptPreview } from '../components/ReceiptPreview'
import { CropModal } from '../components/CropModal'
import { cropReceipt } from '../api/receipts'
import { fmt } from '../lib/utils'

// ── State ─────────────────────────────────────────────────────────────────────

interface ReviewState {
  items:               Receipt['items']
  categoryCorrections: Record<number, string>
  priceCorrections:    Record<number, number>
  nameCorrections:     Record<number, string>
  deletedItemIds:      Set<number>
  manualTotal:         number | null
}

type ReviewAction =
  | { type: 'SET_CATEGORY';    itemId: number; category: string }
  | { type: 'SET_PRICE';       itemId: number; unitPrice: number }
  | { type: 'SET_NAME';        itemId: number; name: string }
  | { type: 'DELETE_ITEM';     itemId: number }
  | { type: 'SET_MANUAL_TOTAL'; total: number | null }

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'SET_CATEGORY':
      return {
        ...state,
        categoryCorrections: { ...state.categoryCorrections, [action.itemId]: action.category },
        items: state.items.map(it =>
          it.id === action.itemId ? { ...it, category: action.category } : it
        ),
      }
    case 'SET_PRICE':
      return {
        ...state,
        priceCorrections: { ...state.priceCorrections, [action.itemId]: action.unitPrice },
        items: state.items.map(it =>
          it.id === action.itemId ? { ...it, price: action.unitPrice } : it
        ),
      }
    case 'SET_NAME':
      return {
        ...state,
        nameCorrections: { ...state.nameCorrections, [action.itemId]: action.name },
        items: state.items.map(it =>
          it.id === action.itemId
            ? { ...it, clean_name: action.name, raw_name: action.name }
            : it
        ),
      }
    case 'DELETE_ITEM': {
      const newDeleted = new Set(state.deletedItemIds)
      newDeleted.add(action.itemId)
      return {
        ...state,
        deletedItemIds: newDeleted,
        items: state.items.filter(it => it.id !== action.itemId),
      }
    }
    case 'SET_MANUAL_TOTAL':
      return { ...state, manualTotal: action.total }
    default:
      return state
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

interface ReviewReceiptProps {
  receipt: Receipt
  isFreshUpload?: boolean
  categories: Category[]
  onSave?: (body: SaveReceiptBody) => Promise<void>
  onClose?: () => void
  onRescan?: () => void
  onDelete?: () => void
}

export function ReviewReceipt({
  receipt,
  isFreshUpload = false,
  categories,
  onSave,
  onClose,
  onRescan,
  onDelete,
}: ReviewReceiptProps) {
  const isVerified = receipt.status === 'verified'

  const [state, dispatch] = useReducer(reviewReducer, {
    items:               receipt.items,
    categoryCorrections: {},
    priceCorrections:    {},
    nameCorrections:     {},
    deletedItemIds:      new Set<number>(),
    manualTotal:         receipt.total ?? null,
  })

  // Locally-added items (not yet in DB, queued for save)
  const [localItems, setLocalItems] = useState<LocalItem[]>([])

  const [saving, setSaving]             = useState(false)
  const [receiptDate, setReceiptDate]   = useState(receipt.receipt_date ?? '')
  const [storeName, setStoreName]       = useState(receipt.store_name ?? '')
  const [cropOpen, setCropOpen]         = useState(false)
  const [imgCacheBust, setImgCacheBust] = useState(0)

  // Expose save to topbar via CustomEvent
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    const handler = () => { handleSaveRef.current?.().catch(console.error) }
    window.addEventListener('pantry:save-receipt', handler)
    return () => window.removeEventListener('pantry:save-receipt', handler)
  }, [])

  // ── Derived verification ─────────────────────────────────────────────────

  const subtotal = useMemo(
    () => state.items.reduce((s, i) => s + i.price * i.quantity, 0)
        + localItems.reduce((s, i) => s + i.price, 0),
    [state.items, localItems]
  )

  const tax   = receipt.tax ?? 0
  const total = state.manualTotal ?? receipt.total

  const { verifyStatus, verifyTitle, verifyDetail } = useMemo(() => {
    if (receipt.total_verified && Object.keys(state.priceCorrections).length === 0
        && state.deletedItemIds.size === 0 && localItems.length === 0) {
      return {
        verifyStatus: 'verified' as const,
        verifyTitle:  'Total Verified',
        verifyDetail: receipt.verification_message ?? `Total: ${fmt(receipt.total ?? 0)}`,
      }
    }
    if (total != null && Math.abs(subtotal + tax - total) < 0.02) {
      return {
        verifyStatus: 'verified' as const,
        verifyTitle:  'Total Verified',
        verifyDetail: `Items ${fmt(subtotal)} + tax ${fmt(tax)} = ${fmt(total)}`,
      }
    }
    if (total != null) {
      return {
        verifyStatus: 'warn' as const,
        verifyTitle:  'Total Not Verified',
        verifyDetail: `Items ${fmt(subtotal)} + tax ${fmt(tax)} = ${fmt(subtotal + tax)}  (receipt: ${fmt(total)})`,
      }
    }
    return {
      verifyStatus: 'fail' as const,
      verifyTitle:  'Total Not Found',
      verifyDetail: receipt.verification_message ?? 'Could not read receipt total.',
    }
  }, [subtotal, tax, total, state.priceCorrections, state.deletedItemIds, localItems, receipt])

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleCategoryChange = useCallback((itemId: number, category: string) => {
    dispatch({ type: 'SET_CATEGORY', itemId, category })
  }, [])

  const handlePriceChange = useCallback((itemId: number, unitPrice: number) => {
    dispatch({ type: 'SET_PRICE', itemId, unitPrice })
  }, [])

  const handleNameChange = useCallback((itemId: number, name: string) => {
    dispatch({ type: 'SET_NAME', itemId, name })
  }, [])

  const handleDeleteItem = useCallback((itemId: number) => {
    dispatch({ type: 'DELETE_ITEM', itemId })
  }, [])

  const handleAddItem = useCallback((item: NewLineItemBody) => {
    setLocalItems(prev => [...prev, { _tempId: nextTempId(), ...item }])
  }, [])

  const handleLocalItemChange = useCallback((tempId: number, patch: Partial<LocalItem>) => {
    setLocalItems(prev => prev.map(it => it._tempId === tempId ? { ...it, ...patch } : it))
  }, [])

  const handleDeleteLocal = useCallback((tempId: number) => {
    setLocalItems(prev => prev.filter(it => it._tempId !== tempId))
  }, [])

  const handleSave = useCallback(async () => {
    if (!onSave) return
    setSaving(true)
    try {
      await onSave({
        corrections: Object.fromEntries(
          Object.entries(state.categoryCorrections).map(([k, v]) => [k, v])
        ),
        price_corrections: Object.fromEntries(
          Object.entries(state.priceCorrections).map(([k, v]) => [k, v])
        ),
        name_corrections: Object.fromEntries(
          Object.entries(state.nameCorrections).map(([k, v]) => [k, v])
        ),
        manual_total:    isVerified ? null : (state.manualTotal ?? null),
        receipt_date:    receiptDate || null,
        store_name:      storeName   || null,
        new_items:       localItems.map(({ name, price, category }) => ({ name, price, category })),
        deleted_item_ids: Array.from(state.deletedItemIds),
      })
    } finally {
      setSaving(false)
    }
  }, [onSave, state, isVerified, receiptDate, storeName, localItems])

  useEffect(() => { handleSaveRef.current = handleSave }, [handleSave])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Verify bar */}
      <VerifyBar
        status={verifyStatus}
        title={verifyTitle}
        detail={verifyDetail}
        onManualTotal={verifyStatus === 'fail'
          ? t => dispatch({ type: 'SET_MANUAL_TOTAL', total: t })
          : undefined
        }
        manualTotal={state.manualTotal}
      />

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-3 mt-2">

        {/* Left: Line items */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 flex flex-col overflow-hidden">

          {/* Card header */}
          <div className="flex items-start justify-between px-3 sm:px-5 py-3 sm:py-4 border-b border-gray-100">
            <div className="flex-1 min-w-0 mr-3">
              <p className="text-[11px] uppercase tracking-widest text-gray-400 font-medium mb-0.5">
                Line Items
              </p>
              <div className="flex items-center gap-2">
                <Store className="w-4 h-4 text-gray-400 shrink-0" />
                {isVerified ? (
                  <h2 className="text-lg font-semibold text-gray-900 leading-tight truncate">
                    {storeName || 'Unknown Store'}
                  </h2>
                ) : (
                  <input
                    type="text"
                    value={storeName}
                    onChange={e => setStoreName(e.target.value)}
                    placeholder="Store name"
                    className="text-lg font-semibold text-gray-900 leading-tight bg-transparent border-none outline-none focus:ring-0 w-full truncate"
                  />
                )}
              </div>
            </div>
            <Badge variant={
              verifyStatus === 'verified' ? 'verified'
              : isVerified ? 'verified'
              : 'review'
            } />
          </div>

          {/* Date row */}
          <div className="flex items-center gap-2 px-3 sm:px-5 py-2 bg-gray-50 border-b border-gray-100">
            <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            <label className="text-xs text-gray-500 font-mono whitespace-nowrap">Receipt date:</label>
            <input
              type="date"
              value={receiptDate}
              onChange={e => setReceiptDate(e.target.value)}
              disabled={isVerified}
              className="text-sm font-mono bg-transparent border-none outline-none cursor-pointer text-gray-700 hover:text-gray-900 disabled:cursor-default"
            />
          </div>

          {/* Items table */}
          <div className="flex-1 overflow-auto">
            <LineItemsTable
              items={state.items}
              localItems={localItems}
              categories={categories}
              locked={isVerified}
              onCategoryChange={handleCategoryChange}
              onPriceChange={handlePriceChange}
              onNameChange={handleNameChange}
              onDeleteItem={handleDeleteItem}
              onAddItem={handleAddItem}
              onLocalItemChange={handleLocalItemChange}
              onDeleteLocal={handleDeleteLocal}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 px-3 sm:px-5 py-3 border-t border-gray-100 bg-gray-50 flex-wrap">
            <div className="flex gap-2 flex-wrap">
              {isFreshUpload && (
                <button onClick={onRescan}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                  <RotateCcw className="w-3.5 h-3.5" />
                  Rescan
                </button>
              )}
              <button onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                <X className="w-3.5 h-3.5" />
                {isVerified ? 'Close' : 'Cancel'}
              </button>
              {onDelete && (
                <button onClick={onDelete}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-500 bg-white border border-red-100 rounded-lg hover:bg-red-50 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )}
            </div>
            {!isVerified && (
              <button onClick={handleSave} disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-[#03a9f4] rounded-lg hover:bg-[#0290d1] disabled:opacity-50 transition-colors shadow-sm">
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save Receipt'}
              </button>
            )}
          </div>
        </div>

        {/* Right: Preview */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 flex flex-col overflow-hidden min-h-80">
          <ReceiptPreview
            ocrText={receipt.ocr_raw}
            receiptId={receipt.id}
            thumbnailPath={receipt.thumbnail_path}
            imgCacheBust={imgCacheBust}
            onEditCrop={receipt.thumbnail_path ? () => setCropOpen(true) : undefined}
          />
        </div>
      </div>

      {/* Re-crop modal */}
      {cropOpen && (
        <CropModal
          receiptId={receipt.id}
          onConfirm={async corners => {
            setCropOpen(false)
            try {
              await cropReceipt(receipt.id, corners)
              setImgCacheBust(n => n + 1)
            } catch (e) {
              console.error('Crop failed', e)
            }
          }}
          onCancel={() => setCropOpen(false)}
        />
      )}
    </div>
  )
}
