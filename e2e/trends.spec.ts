import { test, expect, TRENDS } from './fixtures'

test.describe('Trends Page', () => {
  test('displays stacked bar chart and month breakdown', async ({ page }) => {
    await page.goto('/trends')

    // Chart header
    await expect(page.getByText('Monthly Spending')).toBeVisible()
    await expect(page.getByText(/Last \d+ months/)).toBeVisible()

    // The chart SVG should exist
    const chart = page.locator('svg[aria-label="Monthly spending stacked bar chart"]')
    await expect(chart).toBeVisible()

    // Breakdown section for the latest month (Feb 2026 — selected by default)
    await expect(page.getByText('Breakdown')).toBeVisible()
    // Month label and total appear in both chart header and breakdown — use first()
    await expect(page.getByText('Feb 2026').first()).toBeVisible()
    await expect(page.getByText('$386.44').first()).toBeVisible()
  })

  test('category breakdown rows show all categories with spending', async ({ page }) => {
    await page.goto('/trends')

    // All categories from the latest month should appear in the breakdown
    const lastMonth = TRENDS.months[TRENDS.months.length - 1]
    for (const cat of Object.keys(lastMonth.by_category)) {
      await expect(page.getByText(cat, { exact: true }).first()).toBeVisible()
    }
  })

  test('month navigation with prev/next buttons', async ({ page }) => {
    await page.goto('/trends')

    // Default is the last month (Feb 2026)
    await expect(page.getByText('Feb 2026').first()).toBeVisible()

    // Click previous month
    await page.getByRole('button', { name: 'Previous month' }).click()

    // Should now show Jan 2026
    await expect(page.getByText('Jan 2026').first()).toBeVisible()
    await expect(page.getByText('$350.20').first()).toBeVisible()

    // Click next month to go back to Feb
    await page.getByRole('button', { name: 'Next month' }).click()
    await expect(page.getByText('Feb 2026').first()).toBeVisible()
  })

  test('next button disabled on latest month, prev disabled on oldest', async ({ page }) => {
    await page.goto('/trends')

    // On latest month (Feb 2026), next should be disabled
    await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled()

    // Navigate to oldest month
    for (let i = 0; i < TRENDS.months.length - 1; i++) {
      await page.getByRole('button', { name: 'Previous month' }).click()
    }

    // On oldest month, prev should be disabled
    await expect(page.getByRole('button', { name: 'Previous month' })).toBeDisabled()
  })

  test('clicking a category row expands to show items (desktop)', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'mobile uses bottom sheet — see trends-mobile.spec.ts')
    await page.goto('/trends')

    // Click the "Produce" row to expand it
    const produceRow = page.locator('[role="button"][aria-expanded]').filter({ hasText: 'Produce' })
    await produceRow.click()

    // Should show the category items (from our mock)
    await expect(page.getByText('Organic Bananas')).toBeVisible()
    await expect(page.getByText('Organic Strawberries')).toBeVisible()
    await expect(page.getByText('Avocados')).toBeVisible()

    // Click again to collapse
    await produceRow.click()
    await expect(page.getByText('Organic Bananas')).not.toBeVisible()
  })

  test('empty state shown when no trend data', async ({ page }) => {
    // Override the trends API to return empty data
    await page.route(/\/api\/trends\/monthly/, route =>
      route.fulfill({ json: { months: [], categories: [] } }),
    )

    await page.goto('/trends')
    await expect(page.getByText('No trend data yet')).toBeVisible()
  })
})
