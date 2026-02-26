import { test, expect, RECEIPTS } from './fixtures'

test.describe('All Receipts — Mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile-only tests')

  test('date and items columns are hidden on mobile', async ({ page }) => {
    await page.goto('/receipts')

    // Store names should still be visible
    await expect(page.getByText('Whole Foods').first()).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()

    // Date column header should be hidden
    const dateHeader = page.locator('th').filter({ hasText: 'Date' })
    await expect(dateHeader).toBeHidden()

    // Items column header should be hidden
    const itemsHeader = page.locator('th').filter({ hasText: 'Items' })
    await expect(itemsHeader).toBeHidden()
  })

  test('status badges are compact (icon-only) on mobile', async ({ page }) => {
    await page.goto('/receipts')

    // Compact badges should be visible (sm:hidden span)
    // They render as small circular indicators without text labels
    const compactBadges = page.locator('td span.sm\\:hidden')
    await expect(compactBadges.first()).toBeVisible()

    // Full-text badges should be hidden (hidden sm:inline span)
    const fullBadges = page.locator('td span.hidden.sm\\:inline')
    await expect(fullBadges.first()).toBeHidden()
  })

  test('search filters work on mobile', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('Whole Foods')

    await expect(page.getByText('2 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).not.toBeVisible()
  })

  test('status filter chips work on mobile', async ({ page }) => {
    await page.goto('/receipts')

    await page.getByRole('button', { name: /^Approved$/i }).click()
    await expect(page.getByText('3 receipts')).toBeVisible()

    await page.getByRole('button', { name: /^Pending$/i }).click()
    await expect(page.getByText('3 receipts')).toBeVisible()

    await page.getByRole('button', { name: /^All$/i }).click()
    await expect(page.getByText(`${RECEIPTS.length} receipts`)).toBeVisible()
  })

  test('tapping a receipt row opens review page', async ({ page }) => {
    await page.goto('/receipts')

    await page.getByText('Costco').click()
    await expect(page).toHaveURL(/\/receipts\/3$/)
    await expect(page.getByText('Organic Bananas')).toBeVisible()
  })
})
