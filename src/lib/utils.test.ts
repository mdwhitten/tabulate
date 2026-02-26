import { describe, it, expect } from 'vitest'
import { catColor, catIcon, fmt, fmtShort, relativeTime, storeIcon } from './utils'
import type { Category } from '../types'

// ── fmt ──────────────────────────────────────────────────────────────────────

describe('fmt', () => {
  it('formats a positive number with two decimal places', () => {
    expect(fmt(12.5)).toBe('$12.50')
  })
  it('formats zero', () => {
    expect(fmt(0)).toBe('$0.00')
  })
  it('formats a negative number', () => {
    expect(fmt(-3.1)).toBe('$-3.10')
  })
})

// ── fmtShort ─────────────────────────────────────────────────────────────────

describe('fmtShort', () => {
  it('formats numbers below 1000 as rounded dollars', () => {
    expect(fmtShort(499.9)).toBe('$500')
  })
  it('formats 1000+ as k', () => {
    expect(fmtShort(1500)).toBe('$1.5k')
  })
  it('formats exact thousands', () => {
    expect(fmtShort(2000)).toBe('$2.0k')
  })
})

// ── catColor ─────────────────────────────────────────────────────────────────

describe('catColor', () => {
  it('returns builtin color for known category', () => {
    expect(catColor('Produce')).toBe('#2d7a4f')
  })
  it('returns fallback for unknown category', () => {
    expect(catColor('Imaginary')).toBe('#888')
  })
  it('prefers custom category color over builtin', () => {
    const cats: Category[] = [
      { id: 1, name: 'Produce', icon: '🥬', color: '#ff0000', is_builtin: false, is_disabled: false },
    ]
    expect(catColor('Produce', cats)).toBe('#ff0000')
  })
})

// ── catIcon ──────────────────────────────────────────────────────────────────

describe('catIcon', () => {
  it('returns builtin icon for known category', () => {
    expect(catIcon('Frozen')).toBe('🧊')
  })
  it('returns fallback for unknown category', () => {
    expect(catIcon('Imaginary')).toBe('📦')
  })
  it('prefers custom category icon over builtin', () => {
    const cats: Category[] = [
      { id: 1, name: 'Frozen', icon: '❄️', color: '#000', is_builtin: false, is_disabled: false },
    ]
    expect(catIcon('Frozen', cats)).toBe('❄️')
  })
})

// ── relativeTime ─────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  it('returns "just now" for <2 minutes ago', () => {
    const iso = new Date(Date.now() - 30_000).toISOString()
    expect(relativeTime(iso)).toBe('just now')
  })
  it('returns minutes for 2-59 min', () => {
    const iso = new Date(Date.now() - 10 * 60_000).toISOString()
    expect(relativeTime(iso)).toBe('10m ago')
  })
  it('returns hours for 1-23h', () => {
    const iso = new Date(Date.now() - 3 * 3_600_000).toISOString()
    expect(relativeTime(iso)).toBe('3h ago')
  })
  it('returns days for 1-6d', () => {
    const iso = new Date(Date.now() - 5 * 86_400_000).toISOString()
    expect(relativeTime(iso)).toBe('5d ago')
  })
  it('returns formatted date for 7+ days', () => {
    const iso = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const result = relativeTime(iso)
    // Should be something like "Feb 12" — not contain "ago"
    expect(result).not.toContain('ago')
  })
})

// ── storeIcon ────────────────────────────────────────────────────────────────

describe('storeIcon', () => {
  it('returns default cart for null', () => {
    expect(storeIcon(null)).toBe('🛒')
  })
  it('matches costco', () => {
    expect(storeIcon('Costco Wholesale')).toBe('🏭')
  })
  it('matches H-E-B', () => {
    expect(storeIcon('H-E-B')).toBe('🛒')
  })
  it('matches target', () => {
    expect(storeIcon('Target')).toBe('🎯')
  })
  it('matches walmart', () => {
    expect(storeIcon('Walmart Supercenter')).toBe('🏪')
  })
  it('matches whole foods', () => {
    expect(storeIcon('Whole Foods Market')).toBe('🌿')
  })
  it('matches kroger', () => {
    expect(storeIcon('Kroger')).toBe('🛍️')
  })
  it('matches aldi', () => {
    expect(storeIcon('ALDI')).toBe('🏬')
  })
  it('returns default for unknown store', () => {
    expect(storeIcon('Random Grocery')).toBe('🛒')
  })
})
