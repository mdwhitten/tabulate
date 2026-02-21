import { useRef, useState, useCallback } from 'react'

interface SwipeToDeleteOptions {
  /** Called when swipe exceeds threshold and finger lifts */
  onDelete: () => void
  /** Pixels the user must drag left to trigger delete (default 80) */
  threshold?: number
  /** Disable swipe (e.g. for locked/verified receipts) */
  disabled?: boolean
}

interface SwipeToDeleteResult {
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void
    onTouchMove: (e: React.TouchEvent) => void
    onTouchEnd: () => void
  }
  /** Apply to each cell's inner content — translateX during swipe */
  rowStyle: React.CSSProperties
  /** True when swiped past the delete threshold */
  isPastThreshold: boolean
  /** Current horizontal offset (0 or negative) */
  offset: number
}

/**
 * Enables swipe-left-to-delete on a table row for touch devices.
 *
 * Usage:
 *   const { touchHandlers, rowStyle, isPastThreshold, offset } = useSwipeToDelete({ onDelete })
 *   <tr {...touchHandlers}>
 *     <td><div style={rowStyle}>{content}</div></td>
 *   </tr>
 */
export function useSwipeToDelete({
  onDelete,
  threshold = 80,
  disabled = false,
}: SwipeToDeleteOptions): SwipeToDeleteResult {
  const [offset, setOffset] = useState(0)
  const [animating, setAnimating] = useState(false)

  // Touch tracking via refs (no re-renders during drag)
  const startX = useRef(0)
  const startY = useRef(0)
  const tracking = useRef(false)   // committed to horizontal swipe
  const rejected = useRef(false)   // first move was vertical — ignore rest
  const active = useRef(false)     // a touch sequence is in progress

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return
    const touch = e.touches[0]
    startX.current = touch.clientX
    startY.current = touch.clientY
    tracking.current = false
    rejected.current = false
    active.current = true
    setAnimating(false)
  }, [disabled])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (disabled || !active.current || rejected.current) return

    const touch = e.touches[0]
    const dx = touch.clientX - startX.current
    const dy = touch.clientY - startY.current

    // First significant movement determines intent
    if (!tracking.current) {
      const absDx = Math.abs(dx)
      const absDy = Math.abs(dy)
      // Need at least 8px of movement to decide
      if (absDx < 8 && absDy < 8) return

      if (absDy > absDx || dx > 0) {
        // Vertical scroll or rightward swipe — reject
        rejected.current = true
        return
      }
      // Horizontal leftward swipe — start tracking
      tracking.current = true
    }

    // Prevent vertical scroll while swiping
    e.preventDefault()

    // Clamp: only allow leftward, max -150px
    const clamped = Math.max(-150, Math.min(0, dx))
    setOffset(clamped)
  }, [disabled])

  const onTouchEnd = useCallback(() => {
    if (!active.current) return
    active.current = false

    if (!tracking.current) {
      // Was never a horizontal swipe
      setOffset(0)
      return
    }

    if (offset < -threshold) {
      // Past threshold — delete
      setAnimating(true)
      setOffset(-300) // slide fully off-screen
      setTimeout(() => {
        onDelete()
        setOffset(0)
        setAnimating(false)
      }, 200)
    } else {
      // Snap back
      setAnimating(true)
      setOffset(0)
      setTimeout(() => setAnimating(false), 200)
    }
  }, [offset, threshold, onDelete])

  const rowStyle: React.CSSProperties = {
    transform: offset !== 0 ? `translateX(${offset}px)` : undefined,
    transition: animating ? 'transform 200ms ease-out' : 'none',
  }

  return {
    touchHandlers: { onTouchStart, onTouchMove, onTouchEnd },
    rowStyle,
    isPastThreshold: offset < -threshold,
    offset,
  }
}
