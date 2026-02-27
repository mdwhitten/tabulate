import { test, expect } from './fixtures'

test.describe('Embedded / HA Ingress Mode', () => {
  test.skip(({ isEmbedded }) => !isEmbedded, 'embedded project only')

  test('bottom tab bar is visible and sidebar/hamburger are hidden', async ({ page }) => {
    await page.goto('./')

    // Bottom tab bar should be visible with all tabs
    const tabBar = page.locator('nav.fixed.bottom-0')
    await expect(tabBar).toBeVisible()
    await expect(tabBar.getByText('Dashboard')).toBeVisible()
    await expect(tabBar.getByText('Receipts')).toBeVisible()
    await expect(tabBar.getByText('Trends')).toBeVisible()
    await expect(tabBar.getByText('Manage')).toBeVisible()
    await expect(tabBar.getByText('Scan')).toBeVisible()

    // Sidebar should not exist
    await expect(page.locator('aside')).toHaveCount(0)

    // Hamburger menu should not exist
    await expect(page.locator('button >> svg.lucide-menu')).toHaveCount(0)
  })

  test('tab navigation between pages', async ({ page }) => {
    await page.goto('./')
    await expect(page.getByText('This Month')).toBeVisible()

    const tabBar = page.locator('nav.fixed.bottom-0')

    // Navigate to Receipts
    await tabBar.getByText('Receipts').click()
    await expect(page).toHaveURL(/\/receipts$/)
    await expect(page.getByPlaceholder('Search store or date')).toBeVisible()

    // Navigate to Trends
    await tabBar.getByText('Trends').click()
    await expect(page).toHaveURL(/\/trends$/)
    await expect(page.getByText('Monthly Spending')).toBeVisible()

    // Navigate back to Dashboard
    await tabBar.getByText('Dashboard').click()
    await expect(page).toHaveURL(/hassio_ingress\/test-token\/$/)
    await expect(page.getByText('This Month')).toBeVisible()
  })

  test('Manage tab opens popup with Categories and Learned Items', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')

    // Tap Manage tab — should open a popup, not navigate
    await tabBar.getByText('Manage').click()

    // Popup should appear with sub-items
    const popup = page.locator('.absolute.bottom-full')
    await expect(popup).toBeVisible()
    await expect(popup.getByText('Categories')).toBeVisible()
    await expect(popup.getByText('Learned Items')).toBeVisible()

    // Tap Categories in the popup
    await popup.getByText('Categories').click()
    await expect(page).toHaveURL(/\/categories$/)
    // Popup should close
    await expect(popup).not.toBeVisible()

    // Open Manage popup again and go to Learned Items
    await tabBar.getByText('Manage').click()
    await expect(popup).toBeVisible()
    await popup.getByText('Learned Items').click()
    await expect(page).toHaveURL(/\/learned$/)
    await expect(popup).not.toBeVisible()
  })

  test('Manage popup closes on outside tap', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')
    await tabBar.getByText('Manage').click()

    const popup = page.locator('.absolute.bottom-full')
    await expect(popup).toBeVisible()

    // Click outside the popup (on the main content area)
    await page.locator('main').click({ position: { x: 100, y: 100 } })
    await expect(popup).not.toBeVisible()
  })

  test('Manage popup toggles on repeated tap', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')

    // First tap opens
    await tabBar.getByText('Manage').click()
    await expect(page.locator('.absolute.bottom-full')).toBeVisible()

    // Second tap closes
    await tabBar.getByText('Manage').click()
    await expect(page.locator('.absolute.bottom-full')).not.toBeVisible()
  })

  test('bottom tab bar is hidden during receipt review', async ({ page }) => {
    await page.goto('./receipts/3')

    // Review page should load
    await expect(page.getByText('Costco')).toBeVisible()

    // Bottom tab bar should not be present during review
    await expect(page.locator('nav.fixed.bottom-0')).toHaveCount(0)
  })

  test('Scan button opens upload modal', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')
    await tabBar.getByText('Scan').click()

    // Upload modal should appear
    await expect(page.getByText('Scan Receipt')).toBeVisible()
  })

  test('URLs include the ingress prefix in pushState', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')

    // Navigate to Receipts and verify full URL has ingress prefix
    await tabBar.getByText('Receipts').click()
    await expect(page).toHaveURL(/\/api\/hassio_ingress\/test-token\/receipts$/)

    // Navigate to Trends
    await tabBar.getByText('Trends').click()
    await expect(page).toHaveURL(/\/api\/hassio_ingress\/test-token\/trends$/)

    // Manage → Categories
    await tabBar.getByText('Manage').click()
    await page.locator('.absolute.bottom-full').getByText('Categories').click()
    await expect(page).toHaveURL(/\/api\/hassio_ingress\/test-token\/categories$/)
  })

  test('browser back/forward works with ingress prefix', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')

    // Navigate: Dashboard → Receipts → Trends
    await tabBar.getByText('Receipts').click()
    await expect(page).toHaveURL(/\/receipts$/)
    await tabBar.getByText('Trends').click()
    await expect(page).toHaveURL(/\/trends$/)

    // Back to Receipts
    await page.goBack()
    await expect(page).toHaveURL(/\/receipts$/)

    // Back to Dashboard
    await page.goBack()
    await expect(page).toHaveURL(/hassio_ingress\/test-token\/$/)

    // Forward to Receipts
    await page.goForward()
    await expect(page).toHaveURL(/\/receipts$/)
  })

  test('active tab highlights correctly', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')

    // Dashboard tab should be active (blue text)
    const dashboardBtn = tabBar.locator('button', { hasText: 'Dashboard' })
    await expect(dashboardBtn).toHaveCSS('color', 'rgb(3, 169, 244)')

    // Receipts tab should be inactive (gray)
    const receiptsBtn = tabBar.locator('button', { hasText: 'Receipts' })
    await expect(receiptsBtn).not.toHaveCSS('color', 'rgb(3, 169, 244)')

    // Navigate to Receipts — tab should become active
    await receiptsBtn.click()
    await expect(receiptsBtn).toHaveCSS('color', 'rgb(3, 169, 244)')
    await expect(dashboardBtn).not.toHaveCSS('color', 'rgb(3, 169, 244)')
  })

  test('Manage tab highlights when on Categories or Learned Items', async ({ page }) => {
    await page.goto('./')

    const tabBar = page.locator('nav.fixed.bottom-0')
    const manageBtn = tabBar.locator('button', { hasText: 'Manage' })

    // Manage should not be active on Dashboard
    await expect(manageBtn).not.toHaveCSS('color', 'rgb(3, 169, 244)')

    // Navigate to Categories via Manage popup
    await manageBtn.click()
    await page.locator('.absolute.bottom-full').getByText('Categories').click()

    // Manage tab should now be active
    await expect(manageBtn).toHaveCSS('color', 'rgb(3, 169, 244)')

    // Navigate to Learned Items
    await manageBtn.click()
    await page.locator('.absolute.bottom-full').getByText('Learned Items').click()

    // Manage tab should still be active
    await expect(manageBtn).toHaveCSS('color', 'rgb(3, 169, 244)')
  })

  test('deep link to receipt review works under ingress prefix', async ({ page }) => {
    await page.goto('./receipts/3')

    // Should show review page for receipt 3
    await expect(page.getByText('Costco')).toBeVisible()
    await expect(page.getByText('Organic Bananas')).toBeVisible()

    // URL should have the ingress prefix
    await expect(page).toHaveURL(/\/api\/hassio_ingress\/test-token\/receipts\/3$/)
  })

  test('dashboard content loads correctly under ingress', async ({ page }) => {
    await page.goto('./')

    // Stat cards
    await expect(page.getByText('This Month')).toBeVisible()
    await expect(page.getByText('$386.44')).toBeVisible()

    // Recent receipts
    await expect(page.getByText('Recent Receipts')).toBeVisible()
    await expect(page.getByText('Whole Foods').first()).toBeVisible()
  })
})
