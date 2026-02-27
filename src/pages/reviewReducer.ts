import type { Receipt } from '../types'
import type { LocalItem } from '../components/LineItemsTable'

// ── State ─────────────────────────────────────────────────────────────────────

export interface ReviewState {
  items:               Receipt['items']
  categoryCorrections: Record<number, string>
  priceCorrections:    Record<number, number>
  nameCorrections:     Record<number, string>
  deletedItemIds:      Set<number>
  manualTotal:         number | null
}

export type ReviewAction =
  | { type: 'SET_CATEGORY';    itemId: number; category: string }
  | { type: 'SET_PRICE';       itemId: number; unitPrice: number }
  | { type: 'SET_NAME';        itemId: number; name: string }
  | { type: 'DELETE_ITEM';     itemId: number }
  | { type: 'SET_MANUAL_TOTAL'; total: number | null }
  | { type: 'RESET';           receipt: Receipt }

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
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

export function initialState(receipt: Receipt): ReviewState {
  return {
    items:               receipt.items,
    categoryCorrections: {},
    priceCorrections:    {},
    nameCorrections:     {},
    deletedItemIds:      new Set<number>(),
    manualTotal:         receipt.total ?? null,
  }
}

// ── isDirty ───────────────────────────────────────────────────────────────────

export function isDirty(
  state: ReviewState,
  localItems: LocalItem[],
  storeName: string,
  receiptDate: string,
  receipt: Receipt,
  isVerified: boolean,
): boolean {
  if (isVerified) {
    return (
      Object.keys(state.categoryCorrections).length > 0 ||
      storeName !== (receipt.store_name ?? '') ||
      receiptDate !== (receipt.receipt_date ?? '')
    )
  }
  return (
    Object.keys(state.categoryCorrections).length > 0 ||
    Object.keys(state.priceCorrections).length > 0 ||
    Object.keys(state.nameCorrections).length > 0 ||
    state.deletedItemIds.size > 0 ||
    localItems.length > 0 ||
    storeName !== (receipt.store_name ?? '') ||
    receiptDate !== (receipt.receipt_date ?? '')
  )
}
