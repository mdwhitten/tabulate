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

export type Page = 'dashboard' | 'receipts' | 'trends' | 'categories' | 'learned' | 'review'
