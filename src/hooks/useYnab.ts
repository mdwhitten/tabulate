import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getYnabStatus,
  getYnabConfig,
  saveYnabConfig,
  listYnabBudgets,
  listYnabAccounts,
  listYnabCategories,
  syncReceiptToYnab,
} from '../api/ynab'
import type { YnabConfigBody } from '../types'
import { receiptKeys } from './useReceipts'

export const ynabKeys = {
  all:        () => ['ynab'] as const,
  status:     () => ['ynab', 'status'] as const,
  config:     () => ['ynab', 'config'] as const,
  budgets:    () => ['ynab', 'budgets'] as const,
  accounts:   (budgetId: string) => ['ynab', 'accounts', budgetId] as const,
  categories: (budgetId: string) => ['ynab', 'categories', budgetId] as const,
}

export function useYnabStatus() {
  return useQuery({
    queryKey: ynabKeys.status(),
    queryFn:  getYnabStatus,
  })
}

export function useYnabConfig() {
  return useQuery({
    queryKey: ynabKeys.config(),
    queryFn:  getYnabConfig,
  })
}

export function useYnabBudgets(enabled: boolean) {
  return useQuery({
    queryKey: ynabKeys.budgets(),
    queryFn:  listYnabBudgets,
    enabled,
  })
}

export function useYnabAccounts(budgetId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ynabKeys.accounts(budgetId || ''),
    queryFn:  () => listYnabAccounts(budgetId as string),
    enabled:  enabled && !!budgetId,
  })
}

export function useYnabCategories(budgetId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ynabKeys.categories(budgetId || ''),
    queryFn:  () => listYnabCategories(budgetId as string),
    enabled:  enabled && !!budgetId,
  })
}

export function useSaveYnabConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: YnabConfigBody) => saveYnabConfig(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ynabKeys.config() })
      qc.invalidateQueries({ queryKey: ynabKeys.status() })
    },
  })
}

export function useSyncReceiptToYnab() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (receiptId: number) => syncReceiptToYnab(receiptId),
    onSuccess: (_data, receiptId) => {
      qc.invalidateQueries({ queryKey: receiptKeys.detail(receiptId) })
      qc.invalidateQueries({ queryKey: receiptKeys.list() })
    },
  })
}
