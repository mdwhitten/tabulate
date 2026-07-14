import { apiFetch } from './client'
import type {
  YnabStatus,
  YnabConfig,
  YnabConfigBody,
  YnabBudget,
  YnabAccount,
  YnabCategoryGroup,
  YnabSyncResult,
} from '../types'

export async function getYnabStatus(): Promise<YnabStatus> {
  return apiFetch<YnabStatus>('/ynab/status')
}

export async function getYnabConfig(): Promise<YnabConfig> {
  return apiFetch<YnabConfig>('/ynab/config')
}

export async function saveYnabConfig(body: YnabConfigBody): Promise<YnabConfig> {
  return apiFetch<YnabConfig>('/ynab/config', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function listYnabBudgets(): Promise<YnabBudget[]> {
  return apiFetch<YnabBudget[]>('/ynab/budgets')
}

export async function listYnabAccounts(budgetId: string): Promise<YnabAccount[]> {
  return apiFetch<YnabAccount[]>(`/ynab/budgets/${budgetId}/accounts`)
}

export async function listYnabCategories(budgetId: string): Promise<YnabCategoryGroup[]> {
  return apiFetch<YnabCategoryGroup[]>(`/ynab/budgets/${budgetId}/categories`)
}

export async function syncReceiptToYnab(receiptId: number): Promise<YnabSyncResult> {
  return apiFetch<YnabSyncResult>(`/ynab/receipts/${receiptId}/sync`, {
    method: 'POST',
  })
}
