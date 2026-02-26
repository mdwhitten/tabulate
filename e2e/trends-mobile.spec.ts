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

    // Category items should be visible inside the sheet
    // Use first() because both desktop inline and mobile sheet render the items in DOM
    await expect(page.getByText('Organic Bananas').first()).toBeVisible()
    await expect(page.getByText('Organic Strawberries').first()).toBeVisible()
    await expect(page.getByText('Avocados').first()).toBeVisible()

    // Desktop inline expansion should NOT be visible
    const inlineExpansion = page.locator('.hidden.sm\\:block').filter({ hasText: 'Organic Bananas' })
    await expect(inlineExpansion).toBeHidden()
  })

  test('bottom sheet closes when tapping backdrop', async ({ page }) => {
    await page.goto('/trends')

    // Open the bottom sheet
    const produceRow = page.locator('[role="button"][aria-expanded]').filter({ hasText: 'Produce' })
    await produceRow.click()

    await expect(page.getByText('Organic Bananas').first()).toBeVisible()

    // Tap the backdrop area (top of the overlay, above the sheet)
    const backdrop = page.locator('.fixed.inset-0.z-50')
    await backdrop.click({ position: { x: 10, y: 10 } })

    // Items should no longer be visible
    await expect(page.getByText('Organic Bananas').first()).not.toBeVisible()
  })

  test('bottom sheet closes when tapping close button', async ({ page }) => {
    await page.goto('/trends')

    // Open the bottom sheet
    const produceRow = page.locator('[role="button"][aria-expanded]').filter({ hasText: 'Produce' })
    await produceRow.click()

    await expect(page.getByText('Organic Bananas').first()).toBeVisible()

    // Tap the close (X) button in the sheet header
    const closeButton = page.locator('.fixed.inset-0.z-50 button >> svg.lucide-x')
    await closeButton.click()

    await expect(page.getByText('Organic Bananas').first()).not.toBeVisible()
  })
})
