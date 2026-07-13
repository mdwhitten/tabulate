/**
 * Pure helpers for the multi-upload "review queue".
 *
 * After a batch of receipts is uploaded, they're reviewed one at a time.
 * Approving (or skipping) advances to the next; when the queue is exhausted the
 * caller navigates back to the receipts list. Kept free of React/DOM so the
 * transition logic is unit-testable.
 */

export interface BatchAdvance {
  /** Index to show next (unchanged when `done`). */
  index: number
  /** True when the queue is exhausted — caller should leave the review flow. */
  done: boolean
}

/** Advance from `index` in a batch of `length` items (approve or skip). */
export function advanceBatch(length: number, index: number): BatchAdvance {
  const next = index + 1
  return next < length
    ? { index: next, done: false }
    : { index, done: true }
}

/** A batch is "active" (queue UI shown) only when it has more than one item. */
export function isBatchActive(length: number): boolean {
  return length > 1
}

/** 1-based position for the "n of m" indicator, or null when not a batch. */
export function batchPosition(
  length: number, index: number,
): { current: number; total: number } | null {
  if (!isBatchActive(length) || index < 0 || index >= length) return null
  return { current: index + 1, total: length }
}
