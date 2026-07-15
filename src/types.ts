export interface Category {
  id: number
  name: string
  icon: string
  color: string
  is_builtin: boolean
  is_disabled: boolean
}

export interface LineItem {
  id: number
  raw_name: string
  clean_name: string
  category: string
  category_source: 'learned' | 'manual' | 'ai'
  price: number
  quantity: number
  receipt_id: number
}

export interface Receipt {
  id: number
  store_name: string | null
  receipt_date: string | null
  scanned_at: string
  status: 'pending' | 'review' | 'verified'
  total: number | null
  tax: number | null
  total_verified: boolean
  verification_message: string | null
  ocr_raw: string | null
  image_path: string | null
  thumbnail_path: string | null
  ynab_sync_status?: string | null
  ynab_transaction_id?: string | null
  items: LineItem[]
}

export interface ReceiptSummary {
  id: number
  store_name: string | null
  receipt_date: string | null
  scanned_at: string
  status: 'pending' | 'review' | 'verified'
  total: number | null
  item_count: number
  ynab_sync_status?: string | null
}

export interface MonthSummary {
  year: number
  month: number
  month_label: string
  total: number
  by_category: Record<string, number>
}

export interface TrendsResponse {
  months: MonthSummary[]
  categories: string[]
}

export interface CategoryItemDetail {
  clean_name: string
  raw_name: string
  price: number
  quantity: number
  store_name: string | null
  receipt_date: string | null
}

export interface ItemMapping {
  id: number
  normalized_key: string
  display_name: string
  category: string
  source: 'learned' | 'manual' | 'ai'
  times_seen: number
  last_seen: string
}

export interface NewLineItemBody {
  name: string
  price: number
  category: string
}

export interface SaveReceiptBody {
  corrections: Record<string, string>
  price_corrections: Record<string, number>
  name_corrections: Record<string, string>
  manual_total: number | null
  receipt_date: string | null
  store_name: string | null
  new_items: NewLineItemBody[]
  deleted_item_ids: number[]
  approve?: boolean
}

export interface DuplicateMatch {
  id: number
  store_name: string
  receipt_date: string | null
  total: number | null
  status: string
}

export type Page = 'dashboard' | 'receipts' | 'trends' | 'categories' | 'learned' | 'review' | 'settings'

// ── YNAB integration ──────────────────────────────────────────────────────────
export interface YnabStatus {
  enabled: boolean
  token_present: boolean
  budget_id: string | null
  account_id: string | null
  default_category_id: string | null
  configured: boolean
}

export interface YnabCategoryMapping {
  category_id: number
  ynab_category_id: string
}

export interface YnabConfig extends YnabStatus {
  mappings: YnabCategoryMapping[]
}

export interface YnabConfigBody {
  enabled: boolean
  budget_id: string | null
  account_id: string | null
  default_category_id: string | null
  mappings: YnabCategoryMapping[]
}

export interface YnabBudget {
  id: string
  name: string
}

export interface YnabAccount {
  id: string
  name: string
  closed: boolean
}

export interface YnabCategory {
  id: string
  name: string
}

export interface YnabCategoryGroup {
  id: string
  name: string
  categories: YnabCategory[]
}

export interface YnabSyncResult {
  status: 'synced' | 'skipped' | 'failed'
  reason?: string
  transaction_id?: string
  split?: boolean
}
