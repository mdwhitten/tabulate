import { test, expect } from './fixtures'

test.describe('Trends — Mobile', () => {
  test.skip(({ isMobile, isEmbedded }) => !isMobile || isEmbedded, 'mobile-chrome only')

  test('chart and month breakdown render on mobile', async ({ page }) => {
    await page.goto('/trends')

    await expect(page.getByText('Monthly Spending')).toBeVisible()

    const chart = page.locator('svg[aria-label="Monthly spending stacked bar chart"]')
    await expect(chart).toBeVisible()

    await expect(page.getByText('Breakdown')).toBeVisible()
    // Month label and total appear in both chart header and breakdown — use first()
    await expect(page.getByText('Feb 2026').first()).toBeVisible()
    await expect(page.getByText('$386.44').first()).toBeVisible()
  })

  test('month navigation with prev/next works on mobile', async ({ page }) => {
    await page.goto('/trends')

    await expect(page.getByText('Feb 2026').first()).toBeVisible()

    await page.getByRole('button', { name: 'Previous month' }).click()
    await expect(page.getByText('Jan 2026').first()).toBeVisible()

    await page.getByRole('button', { name: 'Next month' }).click()
    await expect(page.getByText('Feb 2026').first()).toBeVisible()
  })

  test('tapping category opens bottom sheet instead of inline expansion', async ({ page }) => {
    await page.goto('/trends')

    // Tap the "Produce" category row
    const produceRow = page.locator('[role="button"][aria-expanded]').filter({ hasText: 'Produce' })
    await produceRow.click()

    // On mobile, a bottom sheet should appear (sm:hidden container with fixed overlay)
    const bottomSheet = page.locator('.fixed.inset-0.z-50')
    await expect(bottomSheet).toBeVisible()

    // Category items should be visible inside the sheet (scope to bottom sheet to avoid
    // matching the desktop inline expansion which is hidden via CSS on mobile)
    await expect(bottomSheet.getByText('Organic Bananas')).toBeVisible()
    await expect(bottomSheet.getByText('Organic Strawberries')).toBeVisible()
    await expect(bottomSheet.getByText('Avocados')).toBeVisible()
  })

  test('bottom sheet closes when tapping backdrop', async ({ page }) => {
    await page.goto('/trends')

    // Open the bottom sheet
    const produceRow = page.locator('[role="button"][aria-expanded]').filter({ hasText: 'Produce' })
    await produceRow.click()

    const bottomSheet = page.locator('.fixed.inset-0.z-50')
    await expect(bottomSheet.getByText('Organic Bananas')).toBeVisible()

    // Tap the backdrop area (top of the overlay, above the sheet)
    await bottomSheet.click({ position: { x: 10, y: 10 } })

    // Bottom sheet should be gone
    await expect(bottomSheet).toBeHidden()
  })

  test('bottom sheet closes when tapping close button', async ({ page }) => {
    await page.goto('/trends')

    // Open the bottom sheet
    const produceRow = page.locator('[role="button"][aria-expanded]').filter({ hasText: 'Produce' })
    await produceRow.click()

    const bottomSheet = page.locator('.fixed.inset-0.z-50')
    await expect(bottomSheet.getByText('Organic Bananas')).toBeVisible()

    // Tap the close (X) button in the sheet header
    await bottomSheet.locator('button >> svg.lucide-x').click()

    // Bottom sheet should be gone
    await expect(bottomSheet).toBeHidden()
  })
})
