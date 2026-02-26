import { test, expect, DASHBOARD_SUMMARY } from './fixtures'

test.describe('Navigation & Dashboard', () => {
  test('dashboard loads with stat cards and recent receipts', async ({ page }) => {
    await page.goto('/')

    // Stat cards
    await expect(page.getByText('This Month')).toBeVisible()
    await expect(page.getByText('$386.44')).toBeVisible()
    // Sidebar also has a "Receipts" section header — scope to the stat card grid
    await expect(page.locator('.grid').getByText('Receipts', { exact: true })).toBeVisible()
    await expect(page.getByText(String(DASHBOARD_SUMMARY.receipt_count), { exact: true })).toBeVisible()
    await expect(page.getByText('Top Category')).toBeVisible()
    await expect(page.getByText('Avg Trip')).toBeVisible()

    // Recent receipts section
    await expect(page.getByText('Recent Receipts')).toBeVisible()
    await expect(page.getByText('Whole Foods').first()).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
  })

  test('sidebar navigation between all pages', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'sidebar hidden on mobile — see navigation-mobile.spec.ts')
    await page.goto('/')

    // Navigate to All Receipts
    await page.locator('aside button', { hasText: 'All Receipts' }).click()
    await expect(page).toHaveURL(/\/receipts$/)
    await expect(page.getByPlaceholder('Search store or date')).toBeVisible()

    // Navigate to Trends
    await page.locator('aside button', { hasText: 'Trends' }).click()
    await expect(page).toHaveURL(/\/trends$/)
    await expect(page.getByText('Monthly Spending')).toBeVisible()

    // Navigate to Categories
    await page.locator('aside button', { hasText: 'Categories' }).click()
    await expect(page).toHaveURL(/\/categories$/)
    await expect(page.getByText('New Category')).toBeVisible()

    // Navigate to Learned Items
    await page.locator('aside button', { hasText: 'Learned Items' }).click()
    await expect(page).toHaveURL(/\/learned$/)
    await expect(page.getByPlaceholder('Search items')).toBeVisible()

    // Navigate back to Dashboard
    await page.locator('aside button', { hasText: 'Dashboard' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('This Month')).toBeVisible()
  })

  test('deep link to receipt review page', async ({ page }) => {
    await page.goto('/receipts/3')
    // Pending receipt: store name and item names are editable inputs (locked=false)
    await expect(page.getByPlaceholder('Store name')).toHaveValue('Costco')
    // Items section loaded
    await expect(page.getByRole('button', { name: /Approve/i }).first()).toBeVisible()
  })

  test('dashboard "View all" links navigate correctly', async ({ page }) => {
    await page.goto('/')

    // "View all" in recent receipts → All Receipts
    await page.getByRole('button', { name: /View all/i }).first().click()
    await expect(page).toHaveURL(/\/(receipts|trends)/)
  })

  test('dashboard receipt row click opens review', async ({ page }) => {
    await page.goto('/')
    // Click the first Whole Foods receipt button on the dashboard
    await page.getByRole('button', { name: /Whole Foods/i }).first().click()
    await expect(page).toHaveURL(/\/receipts\/1$/)
  })

  test('browser back/forward works between pages', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'sidebar hidden on mobile — see navigation-mobile.spec.ts')
    await page.goto('/')
    await page.locator('aside button', { hasText: 'All Receipts' }).click()
    await expect(page).toHaveURL(/\/receipts$/)

    await page.locator('aside button', { hasText: 'Trends' }).click()
    await expect(page).toHaveURL(/\/trends$/)

    await page.goBack()
    await expect(page).toHaveURL(/\/receipts$/)

    await page.goBack()
    await expect(page).toHaveURL(/\/$/)

    await page.goForward()
    await expect(page).toHaveURL(/\/receipts$/)
  })
})
