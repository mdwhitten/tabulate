import { test as base, type Page } from '@playwright/test'

// ── Mock data ───────────────────────────────────────────────────────────────

export const CATEGORIES = [
  { id: 1, name: 'Produce',      icon: '🥬', color: '#7ab04f', is_builtin: true,  is_disabled: false, sort_order: 10 },
  { id: 2, name: 'Dairy & Eggs', icon: '🥛', color: '#4f7ab0', is_builtin: true,  is_disabled: false, sort_order: 20 },
  { id: 3, name: 'Meat & Deli',  icon: '🥩', color: '#b04f70', is_builtin: true,  is_disabled: false, sort_order: 30 },
  { id: 4, name: 'Bakery',       icon: '🍞', color: '#b08a4f', is_builtin: true,  is_disabled: false, sort_order: 40 },
  { id: 5, name: 'Beverages',    icon: '🥤', color: '#5898b8', is_builtin: true,  is_disabled: false, sort_order: 50 },
  { id: 6, name: 'Snacks',       icon: '🍿', color: '#8068c0', is_builtin: true,  is_disabled: false, sort_order: 60 },
  { id: 7, name: 'Pantry',       icon: '🥫', color: '#c08850', is_builtin: true,  is_disabled: false, sort_order: 70 },
  { id: 8, name: 'Frozen',       icon: '🧊', color: '#50b090', is_builtin: true,  is_disabled: false, sort_order: 80 },
  { id: 9, name: 'Other',        icon: '🏷️', color: '#a0607a', is_builtin: true,  is_disabled: false, sort_order: 90 },
]

export const RECEIPTS: ReceiptSummary[] = [
  { id: 1, store_name: 'Whole Foods',   receipt_date: '2026-02-20', scanned_at: '2026-02-20T14:30:00Z', status: 'verified', total: 87.42, item_count: 12 },
  { id: 2, store_name: 'Trader Joe\'s', receipt_date: '2026-02-18', scanned_at: '2026-02-18T10:15:00Z', status: 'verified', total: 45.99, item_count: 8 },
  { id: 3, store_name: 'Costco',        receipt_date: '2026-02-15', scanned_at: '2026-02-15T16:45:00Z', status: 'pending',  total: 156.30, item_count: 15 },
  { id: 4, store_name: 'Safeway',       receipt_date: '2026-02-10', scanned_at: '2026-02-10T09:00:00Z', status: 'review',   total: 32.18, item_count: 5 },
  { id: 5, store_name: 'Whole Foods',   receipt_date: '2026-02-05', scanned_at: '2026-02-05T11:20:00Z', status: 'verified', total: 64.55, item_count: 9 },
  { id: 6, store_name: 'Target',        receipt_date: '2026-01-28', scanned_at: '2026-01-28T13:00:00Z', status: 'verified', total: 23.40, item_count: 4 },
]

export const RECEIPT_DETAIL = {
  id: 3,
  store_name: 'Costco',
  receipt_date: '2026-02-15',
  scanned_at: '2026-02-15T16:45:00Z',
  status: 'pending' as const,
  total: 156.30,
  tax: 8.12,
  total_verified: true,
  verification_message: 'Total matches sum of items.',
  ocr_raw: 'COSTCO WHOLESALE\n...',
  image_path: null,
  thumbnail_path: null,
  items: [
    { id: 101, raw_name: 'ORG BANANAS',        clean_name: 'Organic Bananas',       category: 'Produce',      category_source: 'ai' as const, price: 2.49, quantity: 1, receipt_id: 3 },
    { id: 102, raw_name: 'KS WHOLE MILK',       clean_name: 'Kirkland Whole Milk',   category: 'Dairy & Eggs', category_source: 'ai' as const, price: 6.99, quantity: 1, receipt_id: 3 },
    { id: 103, raw_name: 'ROTISSERIE CHKN',     clean_name: 'Rotisserie Chicken',    category: 'Meat & Deli',  category_source: 'ai' as const, price: 4.99, quantity: 1, receipt_id: 3 },
    { id: 104, raw_name: 'KS PAPER TOWELS',     clean_name: 'Paper Towels',          category: 'Other',        category_source: 'ai' as const, price: 18.99, quantity: 1, receipt_id: 3 },
    { id: 105, raw_name: 'ORG STRAWBERRIES',    clean_name: 'Organic Strawberries',  category: 'Produce',      category_source: 'learned' as const, price: 5.99, quantity: 2, receipt_id: 3 },
  ],
}

export const DASHBOARD_SUMMARY = {
  month_total: 386.44,
  receipt_count: 6,
  items_learned: 24,
  avg_trip: 68.31,
}

function makeMonthTrends() {
  const months = [
    { year: 2025, month: 9,  month_label: 'Sep 2025', total: 312.50, by_category: { Produce: 85.20, 'Dairy & Eggs': 42.10, 'Meat & Deli': 78.90, Bakery: 22.30, Beverages: 34.00, Other: 50.00 } },
    { year: 2025, month: 10, month_label: 'Oct 2025', total: 289.00, by_category: { Produce: 72.50, 'Dairy & Eggs': 38.00, 'Meat & Deli': 65.20, Bakery: 28.50, Beverages: 41.80, Other: 43.00 } },
    { year: 2025, month: 11, month_label: 'Nov 2025', total: 445.80, by_category: { Produce: 95.00, 'Dairy & Eggs': 55.30, 'Meat & Deli': 120.00, Bakery: 35.50, Beverages: 60.00, Other: 80.00 } },
    { year: 2025, month: 12, month_label: 'Dec 2025', total: 520.40, by_category: { Produce: 102.30, 'Dairy & Eggs': 48.90, 'Meat & Deli': 145.60, Bakery: 42.80, Beverages: 78.80, Other: 102.00 } },
    { year: 2026, month: 1,  month_label: 'Jan 2026', total: 350.20, by_category: { Produce: 88.40, 'Dairy & Eggs': 45.00, 'Meat & Deli': 92.50, Bakery: 30.00, Beverages: 52.30, Other: 42.00 } },
    { year: 2026, month: 2,  month_label: 'Feb 2026', total: 386.44, by_category: { Produce: 92.30, 'Dairy & Eggs': 51.20, 'Meat & Deli': 105.80, Bakery: 32.14, Beverages: 55.00, Other: 50.00 } },
  ]
  const categories = ['Produce', 'Dairy & Eggs', 'Meat & Deli', 'Bakery', 'Beverages', 'Other']
  return { months, categories }
}

export const TRENDS = makeMonthTrends()

export const CATEGORY_ITEMS = [
  { clean_name: 'Organic Bananas',      raw_name: 'ORG BANANAS',      price: 2.49, quantity: 2, store_name: 'Costco',      receipt_date: '2026-02-15' },
  { clean_name: 'Organic Strawberries', raw_name: 'ORG STRAWBERRIES', price: 5.99, quantity: 1, store_name: 'Whole Foods', receipt_date: '2026-02-20' },
  { clean_name: 'Avocados',             raw_name: 'AVOCADOS 4PK',     price: 4.99, quantity: 1, store_name: 'Trader Joe\'s', receipt_date: '2026-02-18' },
]

export const MAPPINGS = {
  items: [
    { id: 1, normalized_key: 'org bananas',      display_name: 'Organic Bananas',      category: 'Produce',      source: 'learned' as const, times_seen: 8,  last_seen: '2026-02-20T14:30:00Z' },
    { id: 2, normalized_key: 'whole milk',        display_name: 'Whole Milk',           category: 'Dairy & Eggs', source: 'learned' as const, times_seen: 5,  last_seen: '2026-02-18T10:15:00Z' },
    { id: 3, normalized_key: 'rotisserie chkn',   display_name: 'Rotisserie Chicken',   category: 'Meat & Deli',  source: 'ai' as const,      times_seen: 3,  last_seen: '2026-02-15T16:45:00Z' },
    { id: 4, normalized_key: 'ks paper towels',   display_name: 'Paper Towels',         category: 'Other',        source: 'manual' as const,  times_seen: 2,  last_seen: '2026-02-10T09:00:00Z' },
    { id: 5, normalized_key: 'sourdough bread',   display_name: 'Sourdough Bread',      category: 'Bakery',       source: 'learned' as const, times_seen: 6,  last_seen: '2026-02-05T11:20:00Z' },
  ],
  total: 5,
}

// ── Types (mirror frontend just for mock typing) ────────────────────────────

interface ReceiptSummary {
  id: number
  store_name: string | null
  receipt_date: string | null
  scanned_at: string
  status: string
  total: number | null
  item_count: number
}

// ── Route mocking helper ────────────────────────────────────────────────────

/** Set up all standard API mocks so the app renders without a real backend. */
export async function mockAllApis(page: Page) {
  // Categories — used by almost every page
  await page.route('**/api/categories', route =>
    route.fulfill({ json: CATEGORIES }),
  )

  // Receipts list
  await page.route('**/api/receipts', route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: RECEIPTS })
    }
    return route.continue()
  })

  // Single receipt (any id)
  await page.route(/\/api\/receipts\/\d+$/, route => {
    if (route.request().method() === 'GET') {
      const url = route.request().url()
      const id = Number(url.match(/\/receipts\/(\d+)$/)?.[1])
      return route.fulfill({ json: { ...RECEIPT_DETAIL, id } })
    }
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 204 })
    }
    return route.continue()
  })

  // Save receipt
  await page.route(/\/api\/receipts\/\d+\/save/, route =>
    route.fulfill({ json: { status: 'ok' } }),
  )

  // Dashboard summary
  await page.route('**/api/trends/summary', route =>
    route.fulfill({ json: DASHBOARD_SUMMARY }),
  )

  // Monthly trends
  await page.route('**/api/trends/monthly?*', route =>
    route.fulfill({ json: TRENDS }),
  )
  await page.route(/\/api\/trends\/monthly$/, route =>
    route.fulfill({ json: TRENDS }),
  )

  // Category items drill-down
  await page.route(/\/api\/trends\/monthly\/\d+\/\d+\/items/, route =>
    route.fulfill({ json: CATEGORY_ITEMS }),
  )

  // Item mappings
  await page.route('**/api/items/mappings?*', route =>
    route.fulfill({ json: MAPPINGS }),
  )
  await page.route(/\/api\/items\/mappings$/, route =>
    route.fulfill({ json: MAPPINGS }),
  )

  // Duplicate check
  await page.route('**/api/receipts/check-duplicates*', route =>
    route.fulfill({ json: [] }),
  )

  // Thumbnail / image — return small transparent PNG
  await page.route(/\/api\/receipts\/\d+\/(thumbnail|image)/, route =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==', 'base64'),
    }),
  )

  // Health check
  await page.route('**/api/health', route =>
    route.fulfill({ json: { status: 'ok' } }),
  )
}

// ── Custom test fixture ─────────────────────────────────────────────────────

export const test = base.extend<{ mockApis: void }>({
  mockApis: [async ({ page }, use) => {
    await mockAllApis(page)
    await use()
  }, { auto: true }],
})

export { expect } from '@playwright/test'
