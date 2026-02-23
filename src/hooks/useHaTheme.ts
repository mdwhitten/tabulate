import { useEffect } from 'react'

/**
 * HA CSS variables we care about → Tabulate CSS custom properties.
 *
 * When running inside HA ingress (same-origin iframe), we read theme
 * variables from the parent document and apply them as overrides on <html>.
 * Falls back gracefully: if the parent is inaccessible or the variables
 * aren't set, the defaults in index.css remain untouched.
 */

/** Lighten or darken a hex color by a percentage (-1 to 1). */
function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, Math.max(0, ((num >> 16) & 0xff) + Math.round(255 * amount)))
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + Math.round(255 * amount)))
  const b = Math.min(255, Math.max(0, (num & 0xff) + Math.round(255 * amount)))
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** Perceived luminance of a hex color (0–1). */
function luminance(hex: string): number {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = ((num >> 16) & 0xff) / 255
  const g = ((num >> 8) & 0xff) / 255
  const b = (num & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function readParentVar(name: string): string | null {
  try {
    const val = window.parent.document.documentElement.style.getPropertyValue(name).trim()
    return val || null
  } catch {
    // Cross-origin or no parent — ignore
    return null
  }
}

function applyTheme() {
  const root = document.documentElement

  // Read HA theme accent color
  const accent = readParentVar('--primary-color')
  if (accent) {
    root.style.setProperty('--tab-accent', accent)
    root.style.setProperty('--tab-accent-hover', adjustColor(accent, -0.06))
    root.style.setProperty('--tab-accent-active', adjustColor(accent, -0.12))
  }

  // Detect dark mode from HA background color
  const bgColor = readParentVar('--primary-background-color')
  if (bgColor) {
    const isDark = luminance(bgColor) < 0.4
    if (isDark) {
      root.style.setProperty('--tab-bg', bgColor)
      root.style.setProperty('--tab-text', '#e1e1e1')
      root.style.setProperty('--tab-text-secondary', '#9ca3af')

      const cardBg = readParentVar('--card-background-color') ?? '#1c1c1c'
      root.style.setProperty('--tab-surface', cardBg)

      const divider = readParentVar('--divider-color') ?? '#333333'
      root.style.setProperty('--tab-border', divider)

      root.classList.add('dark')
    } else {
      // Light HA theme — might still differ from Tabulate's default
      root.style.setProperty('--tab-bg', bgColor)

      const cardBg = readParentVar('--card-background-color')
      if (cardBg) root.style.setProperty('--tab-surface', cardBg)

      const divider = readParentVar('--divider-color')
      if (divider) root.style.setProperty('--tab-border', divider)
    }
  }
}

/**
 * Read HA theme variables from the parent iframe and apply them.
 * Only active when `enabled` is true (i.e. running inside HA ingress).
 * Applies once on mount (page load / refresh). Theme changes in HA
 * typically mean navigating away from the add-on, so continuous polling
 * is unnecessary — the fresh theme is picked up on next load.
 */
export function useHaTheme(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    applyTheme()
  }, [enabled])
}
