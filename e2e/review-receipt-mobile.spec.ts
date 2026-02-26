import { test, expect, RECEIPT_DETAIL } from './fixtures'

/** Mock route that returns a verified receipt for id=1 and captures save requests. */
async function mockVerifiedReceipt(page: import('@playwright/test').Page) {
  const captured: { body: Record<string, unknown> | null } = { body: null }

  await page.route(/\/api\/receipts\/1$/, route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { ...RECEIPT_DETAIL, id: 1, status: 'verified' },
      })
    }
    return route.continue()
  })

  await page.route(/\/api\/receipts\/1\/save/, route => {
    if (route.request().method() === 'POST') {
      captured.body = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ json: { status: 'ok' } })
    }
    return route.continue()
  })

  return captured
}

test.describe('Review Receipt — Mobile Edit Flow', () => {
  // Only run in mobile-chrome project
  test.skip(({ isMobile, isEmbedded }) => !isMobile || isEmbedded, 'mobile-chrome only')

  test('verified receipt shows pencil icon edit button on mobile', async ({ page }) => {
    await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Desktop "Edit" button with label should be hidden on mobile
    await expect(page.getByRole('button', { name: /^Edit$/i })).toBeHidden()

    // Pencil icon button (topbar, sm:hidden) should be visible
    // It's the only visible button containing an SVG pencil icon in the topbar
    const pencilButton = page.locator('button:visible >> svg.lucide-pencil').first()
    await expect(pencilButton).toBeVisible({ timeout: 5000 })
  })

  test('tapping pencil unlocks store name and date on mobile', async ({ page }) => {
    await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Date should be disabled in locked mode
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeDisabled()

    // Tap the pencil icon to enter edit mode
    const pencilButton = page.locator('button:visible >> svg.lucide-pencil').first()
    await pencilButton.click()

    // Store name should now be an editable input
    await expect(page.getByPlaceholder('Store name')).toBeVisible()
    await expect(page.getByPlaceholder('Store name')).toBeEditable()

    // Date should now be enabled
    await expect(dateInput).toBeEnabled()
  })

  test('editing store name on mobile and saving via overflow menu', async ({ page }) => {
    const captured = await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Enter edit mode
    const pencilButton = page.locator('button:visible >> svg.lucide-pencil').first()
    await pencilButton.click()

    // Change store name
    const storeInput = page.getByPlaceholder('Store name')
    await storeInput.clear()
    await storeInput.fill('Costco Wholesale')

    // On mobile, the Save button is inside the overflow menu (•••)
    // Open the overflow menu
    const overflowButton = page.locator('button:visible >> svg.lucide-ellipsis-vertical')
    await expect(overflowButton).toBeVisible({ timeout: 3000 })
    await overflowButton.click()

    // Click Save inside the menu
    const menuSave = page.locator('div[class*="absolute"] >> button:has-text("Save")')
    await expect(menuSave).toBeVisible()

    // Wait for save API call to complete before checking captured body
    const saveResponse = page.waitForResponse(resp => /\/api\/receipts\/\d+\/save/.test(resp.url()))
    await menuSave.click()
    await saveResponse

    // Verify payload
    expect(captured.body).toBeTruthy()
    expect(captured.body!.store_name).toBe('Costco Wholesale')
    expect(captured.body!.approve).toBe(false)
  })

  test('editing date on mobile and saving via footer Save button', async ({ page }) => {
    const captured = await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Enter edit mode
    const pencilButton = page.locator('button:visible >> svg.lucide-pencil').first()
    await pencilButton.click()

    // Change the date
    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill('2026-03-01')

    // After editing, the footer Save button should be visible on mobile too
    // (footer is only hidden when isLocked, which is no longer true)
    const saveButton = page.getByRole('button', { name: /^Save$/i })
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    // Wait for save API call to complete before checking captured body
    const saveResponse = page.waitForResponse(resp => /\/api\/receipts\/\d+\/save/.test(resp.url()))
    await saveButton.click()
    await saveResponse

    // Verify payload
    expect(captured.body).toBeTruthy()
    expect(captured.body!.receipt_date).toBe('2026-03-01')
    expect(captured.body!.approve).toBe(false)
  })
})
