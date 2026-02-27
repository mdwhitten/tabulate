import { test, expect } from './fixtures'

test.describe('Navigation & Dashboard — Mobile', () => {
  test.skip(({ isMobile, isEmbedded }) => !isMobile || isEmbedded, 'mobile-chrome only')

  test('hamburger menu opens sidebar overlay and navigates between pages', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('This Month')).toBeVisible()

    // Sidebar should not be visible (off-screen) on mobile
    const sidebar = page.locator('aside')
    await expect(sidebar).not.toBeInViewport()

    // Open hamburger menu
    const hamburger = page.locator('button >> svg.lucide-menu')
    await expect(hamburger).toBeVisible()
    await hamburger.click()

    // Sidebar overlay should appear
    await expect(sidebar).toBeInViewport()

    // Navigate to All Receipts
    await sidebar.getByText('All Receipts').click()
    await expect(page).toHaveURL(/\/receipts$/)
    await expect(page.getByPlaceholder('Search store or date')).toBeVisible()

    // Sidebar should close after navigation
    await expect(sidebar).not.toBeInViewport()

    // Open hamburger again and go to Trends
    await hamburger.click()
    await sidebar.getByText('Trends').click()
    await expect(page).toHaveURL(/\/trends$/)
    await expect(page.getByText('Monthly Spending')).toBeVisible()

    // Navigate to Categories
    await hamburger.click()
    await sidebar.getByText('Categories').click()
    await expect(page).toHaveURL(/\/categories$/)

    // Navigate to Learned Items
    await hamburger.click()
    await sidebar.getByText('Learned Items').click()
    await expect(page).toHaveURL(/\/learned$/)

    // Navigate back to Dashboard
    await hamburger.click()
    await sidebar.getByText('Dashboard').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('This Month')).toBeVisible()
  })

  test('tapping overlay backdrop closes sidebar', async ({ page }) => {
    await page.goto('/')

    // Open sidebar
    const hamburger = page.locator('button >> svg.lucide-menu')
    await hamburger.click()

    const sidebar = page.locator('aside')
    await expect(sidebar).toBeInViewport()

    // Click the overlay backdrop (the fixed dark overlay behind the sidebar)
    const overlay = page.locator('.fixed.inset-0.bg-black\\/50')
    await overlay.click({ position: { x: 300, y: 300 } })

    // Sidebar should close
    await expect(sidebar).not.toBeInViewport()
  })

  test('browser back/forward works on mobile', async ({ page }) => {
    await page.goto('/')

    const hamburger = page.locator('button >> svg.lucide-menu')

    // Navigate to Receipts
    await hamburger.click()
    await page.locator('aside').getByText('All Receipts').click()
    await expect(page).toHaveURL(/\/receipts$/)

    // Navigate to Trends
    await hamburger.click()
    await page.locator('aside').getByText('Trends').click()
    await expect(page).toHaveURL(/\/trends$/)

    // Back to Receipts
    await page.goBack()
    await expect(page).toHaveURL(/\/receipts$/)

    // Back to Dashboard
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)

    // Forward to Receipts
    await page.goForward()
    await expect(page).toHaveURL(/\/receipts$/)
  })

  test('dashboard stat cards and recent receipts render on mobile', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('This Month')).toBeVisible()
    await expect(page.getByText('$386.44')).toBeVisible()
    await expect(page.getByText('Recent Receipts')).toBeVisible()
    await expect(page.getByText('Whole Foods').first()).toBeVisible()
  })
})
