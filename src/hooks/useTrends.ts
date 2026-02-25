import { useQuery } from '@tanstack/react-query'
import { getMonthlyTrends, getCategoryItems, getDashboardSummary } from '../api/trends'

export function useMonthlyTrends(months = 6) {
  return useQuery({
    queryKey: ['trends', 'monthly', months],
    queryFn:  () => getMonthlyTrends(months),
  })
}

export function useCategoryItems(year: number, month: number, category: string | null) {
  return useQuery({
    queryKey: ['trends', 'category-items', year, month, category],
    queryFn: () => getCategoryItems(year, month, category!),
    enabled: category != null,
  })
}

export function useDashboardSummary() {
  return useQuery({
    queryKey: ['trends', 'summary'],
    queryFn:  getDashboardSummary,
  })
}
