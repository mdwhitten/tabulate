import { apiFetch } from './client'
import type { TrendsResponse, CategoryItemDetail } from '../types'

export interface DashboardSummary {
  month_total: number
  receipt_count: number
  items_learned: number
  avg_trip: number
}

export async function getMonthlyTrends(months = 6): Promise<TrendsResponse> {
  return apiFetch<TrendsResponse>(`/trends/monthly?months=${months}`)
}

export async function getCategoryItems(
  year: number, month: number, category: string,
): Promise<CategoryItemDetail[]> {
  return apiFetch<CategoryItemDetail[]>(
    `/trends/monthly/${year}/${month}/items?category=${encodeURIComponent(category)}`,
  )
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return apiFetch<DashboardSummary>('/trends/summary')
}
