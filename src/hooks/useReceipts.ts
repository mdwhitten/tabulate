import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listReceipts,
  getReceipt,
  uploadReceipt,
  saveReceipt,
  deleteReceipt,
} from '../api/receipts'
import type { CropCorners } from '../api/receipts'
import type { SaveReceiptBody } from '../types'

export const receiptKeys = {
  all:    () => ['receipts']          as const,
  list:   () => ['receipts', 'list']  as const,
  detail: (id: number) => ['receipts', id] as const,
}

export function useReceiptList() {
  return useQuery({
    queryKey: receiptKeys.list(),
    queryFn:  listReceipts,
  })
}

export function useReceipt(id: number | null) {
  return useQuery({
    queryKey: receiptKeys.detail(id!),
    queryFn:  () => getReceipt(id!),
    enabled:  id != null,
  })
}

export function useUploadReceipt() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, cropCorners }: { file: File; cropCorners?: CropCorners | null }) =>
      uploadReceipt(file, cropCorners),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: receiptKeys.list() })
    },
  })
}

export function useSaveReceipt(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SaveReceiptBody) => saveReceipt(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: receiptKeys.detail(id) })
      qc.invalidateQueries({ queryKey: receiptKeys.list() })
    },
  })
}

export function useDeleteReceipt() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteReceipt(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: receiptKeys.list() })
    },
  })
}
