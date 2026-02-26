import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AlertTriangle, CalendarDays, Store, RotateCcw, Save, Trash2, CheckCircle } from 'lucide-react'
import type { Receipt, Category, SaveReceiptBody, NewLineItemBody } from '../types'
import { Badge } from '../components/Badge'
import { VerifyBar } from '../components/VerifyBar'
import { LineItemsTable } from '../components/LineItemsTable'
import type { LocalItem } from '../components/LineItemsTable'
import { nextTempId } from '../components/LineItemsTable'
import { ReceiptPreview } from '../components/ReceiptPreview'
import { CropModal } from '../components/CropModal'
import { cropReceipt } from '../api/receipts'
import { useRecategorize } from '../hooks/useReceipts'
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
  | { type: 'RESET';           receipt: Receipt }

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'SET_CATEGORY':
      return {
        ...state,
        categoryCorrections: { ...state.categoryCorrections, [action.itemId]: action.category },
        items: state.items.map(it =>
          it.id === action.itemId ? { ...it, category: action.category, category_source: 'manual' as const } : it
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
            ? { ...it, clean_name: action.name }
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
    case 'RESET':
      return {
        items:               action.receipt.items,
        categoryCorrections: {},
        priceCorrections:    {},
        nameCorrections:     {},
        deletedItemIds:      new Set<number>(),
        manualTotal:         action.receipt.total ?? null,
      }
    default:
      return state
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

interface ReviewReceiptProps {
  receipt: Receipt
  isFreshUpload?: boolean
  categorizationFailed?: boolean
  categories: Category[]
  onSave?: (body: SaveReceiptBody) => Promise<void>
  onRescan?: () => void
  onDelete?: () => void
}

export function ReviewReceipt({
  receipt,
  isFreshUpload = false,
  categorizationFailed: initialCategorizationFailed = false,
  categories,
  onSave,
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
  const [dateError, setDateError]       = useState(false)
  const [catFailed, setCatFailed]       = useState(initialCategorizationFailed)
  const recategorize = useRecategorize(receipt.id)
  const dateInputRef = useRef<HTMLInputElement>(null)

  // Reset local state when the receipt prop changes (e.g. after draft save refetch)
  const prevReceiptRef = useRef(receipt)
  useEffect(() => {
    if (prevReceiptRef.current !== receipt) {
      prevReceiptRef.current = receipt
      dispatch({ type: 'RESET', receipt })
      setLocalItems([])
      setStoreName(receipt.store_name ?? '')
      setReceiptDate(receipt.receipt_date ?? '')
      setCatFailed(false)  // clear banner on receipt change / refetch
    }
  }, [receipt])

  // ── Dirty tracking ──────────────────────────────────────────────────────

  const isDirty = useMemo(() => {
    // Verified receipts can still have category corrections
    if (isVerified) return Object.keys(state.categoryCorrections).length > 0
    return (
      Object.keys(state.categoryCorrections).length > 0 ||
      Object.keys(state.priceCorrections).length > 0 ||
      Object.keys(state.nameCorrections).length > 0 ||
      state.deletedItemIds.size > 0 ||
      localItems.length > 0 ||
      storeName !== (receipt.store_name ?? '') ||
      receiptDate !== (receipt.receipt_date ?? '')
    )
  }, [isVerified, state, localItems, storeName, receiptDate, receipt])

  // Warn on browser refresh / close when there are unsaved edits
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // Expose dirty + editable + verified state so App.tsx can guard navigation / show Save
  // Verified receipts are "editable" when they have pending category changes
  useEffect(() => {
    const w = window as any
    w.__tabulate_isDirty = isDirty
    w.__tabulate_isEditable = !isVerified || isDirty
    w.__tabulate_isVerified = isVerified
    return () => {
      w.__tabulate_isDirty = false
      w.__tabulate_isEditable = false
      w.__tabulate_isVerified = false
    }
  }, [isDirty, isVerified])

  // Expose save/approve/rescan/delete to topbar via CustomEvents
  const handleSaveRef = useRef<((approve: boolean) => Promise<void>) | null>(null)
  const onRescanRef = useRef(onRescan)
  const onDeleteRef = useRef(onDelete)
  useEffect(() => { onRescanRef.current = onRescan }, [onRescan])
  useEffect(() => { onDeleteRef.current = onDelete }, [onDelete])
  useEffect(() => {
    const onSaveEvent    = () => { handleSaveRef.current?.(false).catch(console.error) }
    const onApproveEvent = () => { handleSaveRef.current?.(true).catch(console.error) }
    const onRescanEvent  = () => { onRescanRef.current?.() }
    const onDeleteEvent  = () => { onDeleteRef.current?.() }
    window.addEventListener('tabulate:save-receipt', onSaveEvent)
    window.addEventListener('tabulate:approve-receipt', onApproveEvent)
    window.addEventListener('tabulate:rescan-receipt', onRescanEvent)
    window.addEventListener('tabulate:delete-receipt', onDeleteEvent)
    return () => {
      window.removeEventListener('tabulate:save-receipt', onSaveEvent)
      window.removeEventListener('tabulate:approve-receipt', onApproveEvent)
      window.removeEventListener('tabulate:rescan-receipt', onRescanEvent)
      window.removeEventListener('tabulate:delete-receipt', onDeleteEvent)
    }
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
        verifyStatus: 'balanced' as const,
        verifyTitle:  'Total Balanced',
        verifyDetail: receipt.verification_message ?? `Total: ${fmt(receipt.total ?? 0)}`,
      }
    }
    if (total != null && Math.abs(subtotal + tax - total) < 0.02) {
      return {
        verifyStatus: 'balanced' as const,
        verifyTitle:  'Total Balanced',
        verifyDetail: `Items ${fmt(subtotal)} + tax ${fmt(tax)} = ${fmt(total)}`,
      }
    }
    if (total != null) {
      return {
        verifyStatus: 'warn' as const,
        verifyTitle:  'Total Mismatch',
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

  const handleSave = useCallback(async (approve: boolean) => {
    if (!onSave) return
    // Require a date before saving
    if (!receiptDate) {
      setDateError(true)
      dateInputRef.current?.focus()
      return
    }
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
        approve,
      })
    } finally {
      setSaving(false)
    }
  }, [onSave, state, isVerified, receiptDate, storeName, localItems])

  useEffect(() => { handleSaveRef.current = handleSave }, [handleSave])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Categorization failure banner */}
      {catFailed && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl mb-2">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
          <p className="flex-1 text-sm text-amber-800">
            AI categorization failed — items defaulted to "Other".
          </p>
          <button
            onClick={async () => {
              const result = await recategorize.mutateAsync()
              if (!result.categorization_failed) setCatFailed(false)
            }}
            disabled={recategorize.isPending}
            className="px-3 py-1.5 text-xs font-semibold text-amber-700 bg-white border border-amber-300 rounded-lg hover:bg-amber-50 disabled:opacity-50 transition-colors"
          >
            {recategorize.isPending ? 'Retrying…' : 'Retry'}
          </button>
          <button
            onClick={() => setCatFailed(false)}
            className="px-3 py-1.5 text-xs font-medium text-amber-600 hover:text-amber-800 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

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
        difference={total != null ? total - subtotal - tax : undefined}
        onAddDifference={!isVerified && verifyStatus === 'warn'
          ? (diff) => {
              const rounded = Math.round(diff * 100) / 100
              if (Math.abs(rounded) >= 0.01) {
                handleAddItem({ name: 'Adjustment', price: rounded, category: 'Other' })
              }
            }
          : undefined
        }
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
              isVerified ? 'verified'
              : verifyStatus === 'balanced' ? 'pending'
              : 'review'
            } />
          </div>

          {/* Date row */}
          <div className={`flex items-center gap-2 px-3 sm:px-5 py-2 border-b ${dateError && !receiptDate ? 'bg-red-50 border-b-red-200' : 'bg-gray-50 border-b-gray-100'}`}>
            <CalendarDays className={`w-3.5 h-3.5 shrink-0 ${dateError && !receiptDate ? 'text-red-400' : 'text-gray-400'}`} />
            <label className={`text-xs font-mono whitespace-nowrap ${dateError && !receiptDate ? 'text-red-500' : 'text-gray-500'}`}>
              Receipt date{!isVerified && <span className="text-red-400">*</span>}:
            </label>
            <div className="relative flex-1 min-w-0">
              <input
                ref={dateInputRef}
                type="date"
                value={receiptDate}
                onChange={e => { setReceiptDate(e.target.value); if (e.target.value) setDateError(false) }}
                disabled={isVerified}
                className={[
                  'text-sm font-mono outline-none w-full',
                  isVerified
                    ? 'bg-transparent border-none cursor-default text-gray-700'
                    : [
                        'bg-white border rounded-lg px-2 py-1.5 cursor-pointer',
                        dateError && !receiptDate
                          ? 'text-red-500 border-red-300'
                          : receiptDate
                            ? 'text-gray-700 border-gray-200 hover:border-gray-400'
                            : 'text-gray-400 border-dashed border-gray-300 hover:border-gray-400',
                      ].join(' '),
                ].join(' ')}
              />
              {!receiptDate && !isVerified && (
                <span
                  className={`absolute left-2.5 top-1/2 -translate-y-1/2 text-xs pointer-events-none ${dateError ? 'text-red-400' : 'text-gray-400'}`}
                >
                  Tap to add date
                </span>
              )}
            </div>
            {dateError && !receiptDate && (
              <span className="text-xs text-red-500 whitespace-nowrap">Required</span>
            )}
          </div>

          {/* Items table */}
          <div className="flex-1 overflow-auto">
            <LineItemsTable
              items={state.items}
              localItems={localItems}
              categories={categories}
              locked={isVerified}
              allowCategoryEdit={isVerified}
              onCategoryChange={handleCategoryChange}
              onPriceChange={handlePriceChange}
              onNameChange={handleNameChange}
              onDeleteItem={handleDeleteItem}
              onAddItem={handleAddItem}
              onLocalItemChange={handleLocalItemChange}
              onDeleteLocal={handleDeleteLocal}
            />
          </div>

          {/* Footer — hidden on mobile when no actions are visible */}
          <div className={`flex items-center justify-between gap-2 px-3 sm:px-5 py-3 border-t border-gray-100 bg-gray-50 ${isVerified ? 'hidden sm:flex' : ''}`}>
            {/* Secondary actions — desktop only (mobile uses topbar overflow) */}
            <div className="hidden sm:flex gap-2">
              {isFreshUpload && (
                <button onClick={onRescan}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                  <RotateCcw className="w-3.5 h-3.5" />
                  Rescan
                </button>
              )}
              {onDelete && (
                <button onClick={onDelete}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-500 bg-white border border-red-100 rounded-lg hover:bg-red-50 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )}
            </div>
            {/* Primary actions */}
            {!isVerified ? (
              <div className="flex gap-2 flex-1 sm:flex-none sm:justify-end">
                <button onClick={() => handleSave(false)} disabled={!isDirty || saving}
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  <Save className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => handleSave(true)} disabled={saving}
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors shadow-sm">
                  <CheckCircle className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                  Approve
                </button>
              </div>
            ) : isDirty && (
              <button onClick={() => handleSave(false)} disabled={saving}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <Save className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                {saving ? 'Saving…' : 'Save Categories'}
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
