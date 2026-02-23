import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { listMappings, updateMappingCategory, deleteMapping } from '../api/mappings'
import type { PaginatedMappings } from '../api/mappings'

export const mappingKeys = {
  all:  () => ['mappings'] as const,
  list: (params: { limit?: number; offset?: number; search?: string; category?: string } = {}) =>
    ['mappings', 'list', params] as const,
}

export function useMappingList(params: {
  limit?: number
  offset?: number
  search?: string
  category?: string
} = {}) {
  return useQuery<PaginatedMappings>({
    queryKey:  mappingKeys.list(params),
    queryFn:   () => listMappings(params),
    placeholderData: keepPreviousData,
  })
}

export function useUpdateMappingCategory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, category }: { id: number; category: string }) =>
      updateMappingCategory(id, category),
    onSuccess: () => qc.invalidateQueries({ queryKey: mappingKeys.all() }),
  })
}

export function useDeleteMapping() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteMapping(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: mappingKeys.all() }),
  })
}
