import { test, expect, RECEIPTS } from './fixtures'

test.describe('All Receipts Page', () => {
  test('displays receipt table with all receipts', async ({ page }) => {
    await page.goto('/receipts')

    // All store names should be visible
    await expect(page.getByText('Whole Foods').first()).toBeVisible()
    await expect(page.getByText('Trader Joe\'s')).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
    await expect(page.getByText('Safeway')).toBeVisible()
    await expect(page.getByText('Target')).toBeVisible()

    // Receipt count shown
    await expect(page.getByText(`${RECEIPTS.length} receipts`)).toBeVisible()
  })

  test('search filters receipts by store name', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('Whole Foods')

    // Only Whole Foods receipts should be visible (2 of them)
    await expect(page.getByText('2 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).not.toBeVisible()
    await expect(page.getByText('Trader Joe\'s')).not.toBeVisible()
  })

  test('search filters receipts by date', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('2026-02-15')

    // Only the Costco receipt from Feb 15 should match
    await expect(page.getByText('1 receipt')).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
  })

  test('status filter chips filter by status', async ({ page }) => {
    await page.goto('/receipts')

    // Click "Approved" chip
    await page.getByRole('button', { name: /^Approved$/i }).click()

    // Should show only verified receipts (4: ids 1, 2, 5, 6)
    await expect(page.getByText('4 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).not.toBeVisible()   // pending
    await expect(page.getByText('Safeway')).not.toBeVisible()  // review
    await expect(page.getByText('Whole Foods').first()).toBeVisible()

    // Click "Pending" chip
    await page.getByRole('button', { name: /^Pending$/i }).click()

    // Should show non-verified receipts (2: ids 3, 4)
    await expect(page.getByText('2 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
    await expect(page.getByText('Safeway')).toBeVisible()

    // Click "All" chip
    await page.getByRole('button', { name: /^All$/i }).click()
    await expect(page.getByText(`${RECEIPTS.length} receipts`)).toBeVisible()
  })

  test('clicking a receipt row opens review page', async ({ page }) => {
    await page.goto('/receipts')

    // Click Costco row
    await page.getByText('Costco').click()
    await expect(page).toHaveURL(/\/receipts\/3$/)

    // Review page should load — item names are inputs for pending receipts
    await expect(page.locator('input[value="Organic Bananas"]')).toBeVisible()
  })

  test('empty search shows "No receipts found" message', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('nonexistent store xyz')

    await expect(page.getByText('No receipts found')).toBeVisible()
    await expect(page.getByText('0 receipts')).toBeVisible()
  })

  test('search and status filters combine correctly', async ({ page }) => {
    await page.goto('/receipts')

    // Search for "Whole" + filter to Approved
    await page.getByPlaceholder('Search store or date').fill('Whole')
    await page.getByRole('button', { name: /^Approved$/i }).click()

    // Both Whole Foods receipts are verified → 2 results
    await expect(page.getByText('2 receipts')).toBeVisible()

    // Switch to Pending with same search
    await page.getByRole('button', { name: /^Pending$/i }).click()
    await expect(page.getByText('0 receipts')).toBeVisible()
    await expect(page.getByText('No receipts found')).toBeVisible()
  })
})
