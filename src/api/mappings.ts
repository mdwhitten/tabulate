import { apiFetch } from './client'
import type { ItemMapping } from '../types'

export interface PaginatedMappings {
  items: ItemMapping[]
  total: number
}

export async function listMappings(params: {
  limit?: number
  offset?: number
  search?: string
  category?: string
} = {}): Promise<PaginatedMappings> {
  const qs = new URLSearchParams()
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  if (params.search) qs.set('search', params.search)
  if (params.category) qs.set('category', params.category)
  return apiFetch<PaginatedMappings>(`/items/mappings?${qs}`)
}

export async function updateMappingCategory(
  mappingId: number,
  category: string,
): Promise<{ status: string; mapping_id: number; category: string }> {
  return apiFetch(`/items/mappings/${mappingId}/category`, {
    method: 'PATCH',
    body: JSON.stringify({ category }),
  })
}
