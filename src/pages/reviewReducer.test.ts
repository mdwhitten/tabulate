import { describe, it, expect } from 'vitest'
import { reviewReducer, initialState, isDirty } from './reviewReducer'
import type { ReviewState } from './reviewReducer'
import type { Receipt, LineItem } from '../types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: 1,
    raw_name: 'Milk',
    clean_name: 'Milk',
    category: 'Dairy & Eggs',
    category_source: 'ai',
    price: 3.99,
    quantity: 1,
    receipt_id: 100,
    ...overrides,
  }
}

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 100,
    store_name: 'Costco',
    receipt_date: '2026-02-20',
    scanned_at: '2026-02-20T12:00:00Z',
    status: 'pending',
    total: 50.00,
    tax: 3.50,
    total_verified: true,
    verification_message: null,
    ocr_raw: null,
    image_path: null,
    thumbnail_path: null,
    items: [makeItem()],
    ...overrides,
  }
}

function makeState(receipt?: Receipt): ReviewState {
  return initialState(receipt ?? makeReceipt())
}

// ── reviewReducer ────────────────────────────────────────────────────────────

describe('reviewReducer', () => {
  describe('SET_CATEGORY', () => {
    it('records a category correction', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      expect(next.categoryCorrections).toEqual({ 1: 'Snacks' })
    })

    it('updates the item category in-place', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      expect(next.items[0].category).toBe('Snacks')
    })

    it('sets category_source to manual', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      expect(next.items[0].category_source).toBe('manual')
    })

    it('does not modify other items', () => {
      const receipt = makeReceipt({
        items: [makeItem({ id: 1 }), makeItem({ id: 2, clean_name: 'Bread' })],
      })
      const state = initialState(receipt)
      const next = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      expect(next.items[1].category).toBe('Dairy & Eggs')
    })
  })

  describe('SET_PRICE', () => {
    it('records a price correction', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_PRICE', itemId: 1, unitPrice: 5.99 })
      expect(next.priceCorrections).toEqual({ 1: 5.99 })
    })

    it('updates the item price', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_PRICE', itemId: 1, unitPrice: 5.99 })
      expect(next.items[0].price).toBe(5.99)
    })
  })

  describe('SET_NAME', () => {
    it('records a name correction', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_NAME', itemId: 1, name: 'Whole Milk' })
      expect(next.nameCorrections).toEqual({ 1: 'Whole Milk' })
    })

    it('updates the item clean_name', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_NAME', itemId: 1, name: 'Whole Milk' })
      expect(next.items[0].clean_name).toBe('Whole Milk')
    })
  })

  describe('DELETE_ITEM', () => {
    it('adds the item to deletedItemIds', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'DELETE_ITEM', itemId: 1 })
      expect(next.deletedItemIds.has(1)).toBe(true)
    })

    it('removes the item from the items array', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'DELETE_ITEM', itemId: 1 })
      expect(next.items).toHaveLength(0)
    })

    it('can delete multiple items', () => {
      const receipt = makeReceipt({
        items: [makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })],
      })
      let state = initialState(receipt)
      state = reviewReducer(state, { type: 'DELETE_ITEM', itemId: 1 })
      state = reviewReducer(state, { type: 'DELETE_ITEM', itemId: 3 })
      expect(state.deletedItemIds.size).toBe(2)
      expect(state.items).toHaveLength(1)
      expect(state.items[0].id).toBe(2)
    })
  })

  describe('SET_MANUAL_TOTAL', () => {
    it('sets the manual total', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_MANUAL_TOTAL', total: 99.99 })
      expect(next.manualTotal).toBe(99.99)
    })

    it('can set total to null', () => {
      const state = makeState()
      const next = reviewReducer(state, { type: 'SET_MANUAL_TOTAL', total: null })
      expect(next.manualTotal).toBeNull()
    })
  })

  describe('RESET', () => {
    it('resets all corrections', () => {
      let state = makeState()
      state = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      state = reviewReducer(state, { type: 'SET_PRICE', itemId: 1, unitPrice: 9.99 })
      state = reviewReducer(state, { type: 'SET_NAME', itemId: 1, name: 'Chips' })

      const receipt = makeReceipt()
      const next = reviewReducer(state, { type: 'RESET', receipt })
      expect(next.categoryCorrections).toEqual({})
      expect(next.priceCorrections).toEqual({})
      expect(next.nameCorrections).toEqual({})
      expect(next.deletedItemIds.size).toBe(0)
    })

    it('restores items from the new receipt', () => {
      const state = makeState()
      const newReceipt = makeReceipt({
        items: [makeItem({ id: 5, clean_name: 'Eggs' })],
      })
      const next = reviewReducer(state, { type: 'RESET', receipt: newReceipt })
      expect(next.items).toHaveLength(1)
      expect(next.items[0].clean_name).toBe('Eggs')
    })

    it('uses receipt total for manualTotal', () => {
      const state = makeState()
      const newReceipt = makeReceipt({ total: 123.45 })
      const next = reviewReducer(state, { type: 'RESET', receipt: newReceipt })
      expect(next.manualTotal).toBe(123.45)
    })

    it('sets manualTotal to null when receipt has no total', () => {
      const state = makeState()
      const newReceipt = makeReceipt({ total: null })
      const next = reviewReducer(state, { type: 'RESET', receipt: newReceipt })
      expect(next.manualTotal).toBeNull()
    })
  })

  it('returns same state for unknown action type', () => {
    const state = makeState()
    // @ts-expect-error — testing unknown action
    const next = reviewReducer(state, { type: 'UNKNOWN' })
    expect(next).toBe(state)
  })
})

// ── isDirty ──────────────────────────────────────────────────────────────────

describe('isDirty', () => {
  const receipt = makeReceipt()

  describe('pending receipt', () => {
    it('is not dirty in initial state', () => {
      const state = makeState(receipt)
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, false)).toBe(false)
    })

    it('is dirty when a category is corrected', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, false)).toBe(true)
    })

    it('is dirty when a price is corrected', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'SET_PRICE', itemId: 1, unitPrice: 5.99 })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, false)).toBe(true)
    })

    it('is dirty when a name is corrected', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'SET_NAME', itemId: 1, name: 'Whole Milk' })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, false)).toBe(true)
    })

    it('is dirty when an item is deleted', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'DELETE_ITEM', itemId: 1 })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, false)).toBe(true)
    })

    it('is dirty when local items are added', () => {
      const state = makeState(receipt)
      const localItems = [{ _tempId: 1, name: 'New Item', price: 1.99, category: 'Other' }]
      expect(isDirty(state, localItems, 'Costco', '2026-02-20', receipt, false)).toBe(true)
    })

    it('is dirty when store name changes', () => {
      const state = makeState(receipt)
      expect(isDirty(state, [], 'H-E-B', '2026-02-20', receipt, false)).toBe(true)
    })

    it('is dirty when receipt date changes', () => {
      const state = makeState(receipt)
      expect(isDirty(state, [], 'Costco', '2026-02-25', receipt, false)).toBe(true)
    })
  })

  describe('verified receipt', () => {
    it('is not dirty in initial state', () => {
      const state = makeState(receipt)
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, true)).toBe(false)
    })

    it('is dirty when a category is corrected', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'SET_CATEGORY', itemId: 1, category: 'Snacks' })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, true)).toBe(true)
    })

    it('is dirty when store name changes', () => {
      const state = makeState(receipt)
      expect(isDirty(state, [], 'H-E-B', '2026-02-20', receipt, true)).toBe(true)
    })

    it('is dirty when receipt date changes', () => {
      const state = makeState(receipt)
      expect(isDirty(state, [], 'Costco', '2026-02-25', receipt, true)).toBe(true)
    })

    it('ignores price corrections for verified receipts', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'SET_PRICE', itemId: 1, unitPrice: 99.99 })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, true)).toBe(false)
    })

    it('ignores name corrections for verified receipts', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'SET_NAME', itemId: 1, name: 'Whole Milk' })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, true)).toBe(false)
    })

    it('ignores deleted items for verified receipts', () => {
      let state = makeState(receipt)
      state = reviewReducer(state, { type: 'DELETE_ITEM', itemId: 1 })
      expect(isDirty(state, [], 'Costco', '2026-02-20', receipt, true)).toBe(false)
    })

    it('ignores local items for verified receipts', () => {
      const state = makeState(receipt)
      const localItems = [{ _tempId: 1, name: 'New Item', price: 1.99, category: 'Other' }]
      expect(isDirty(state, localItems, 'Costco', '2026-02-20', receipt, true)).toBe(false)
    })
  })

  describe('null receipt fields', () => {
    it('treats null store_name as empty string', () => {
      const r = makeReceipt({ store_name: null })
      const state = makeState(r)
      expect(isDirty(state, [], '', '2026-02-20', r, false)).toBe(false)
    })

    it('treats null receipt_date as empty string', () => {
      const r = makeReceipt({ receipt_date: null })
      const state = makeState(r)
      expect(isDirty(state, [], 'Costco', '', r, false)).toBe(false)
    })
  })
})
