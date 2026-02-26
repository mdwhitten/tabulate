import { test, expect, RECEIPT_DETAIL } from './fixtures'

/** Mock route that returns a verified receipt for id=1 and captures save requests. */
function mockVerifiedReceipt(page: import('@playwright/test').Page) {
  const captured: { body: Record<string, unknown> | null } = { body: null }

  // Override single-receipt GET to return a verified receipt
  page.route(/\/api\/receipts\/1$/, route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { ...RECEIPT_DETAIL, id: 1, status: 'verified' },
      })
    }
    return route.continue()
  })

  // Capture save body
  page.route(/\/api\/receipts\/1\/save/, route => {
    if (route.request().method() === 'POST') {
      captured.body = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ json: { status: 'ok' } })
    }
    return route.continue()
  })

  return captured
}

test.describe('Review Receipt Page', () => {
  test('displays receipt details with all line items', async ({ page }) => {
    await page.goto('/receipts/3')

    // Store name and date
    await expect(page.getByText('Costco')).toBeVisible()

    // All items should be visible
    for (const item of RECEIPT_DETAIL.items) {
      await expect(page.getByText(item.clean_name)).toBeVisible()
    }
  })

  test('"All Receipts" back button navigates to receipts page', async ({ page }) => {
    await page.goto('/receipts/3')

    // Click the back button
    await page.getByRole('button', { name: /All Receipts/i }).click()
    await expect(page).toHaveURL(/\/receipts$/)
  })

  test('pending receipt shows Approve button', async ({ page }) => {
    await page.goto('/receipts/3')

    // Wait for the review page to render and expose its state
    // The Approve button should be visible for a pending receipt
    await expect(page.getByRole('button', { name: /Approve/i })).toBeVisible({ timeout: 5000 })
  })

  test('verified receipt shows Edit button instead of Save/Approve', async ({ page }) => {
    mockVerifiedReceipt(page)
    await page.goto('/receipts/1')

    // Edit button should be visible (locked mode)
    await expect(page.getByRole('button', { name: /Edit/i })).toBeVisible({ timeout: 5000 })
  })

  test('clicking Edit on verified receipt unlocks store name and date', async ({ page }) => {
    mockVerifiedReceipt(page)
    await page.goto('/receipts/1')

    // Wait for content to render
    await expect(page.getByText('Costco')).toBeVisible()

    // Store name should be plain text (not an input) in locked mode
    await expect(page.getByPlaceholder('Store name')).not.toBeVisible()
    // Date input should be disabled
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeDisabled()

    // Click Edit (footer button on desktop)
    await page.getByRole('button', { name: /Edit/i }).click()

    // Store name should now be an editable input
    await expect(page.getByPlaceholder('Store name')).toBeVisible()
    await expect(page.getByPlaceholder('Store name')).toBeEditable()

    // Date input should now be enabled
    await expect(dateInput).toBeEnabled()

    // Save button should appear (disabled until changes are made)
    await expect(page.getByRole('button', { name: /^Save$/i })).toBeVisible()
    // Approve button should NOT appear (this is an edit, not a new review)
    await expect(page.getByRole('button', { name: /Approve/i })).not.toBeVisible()
  })

  test('editing verified receipt store name enables Save and sends correct payload', async ({ page }) => {
    const captured = mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByText('Costco')).toBeVisible()

    // Enter edit mode
    await page.getByRole('button', { name: /Edit/i }).click()

    // Change store name
    const storeInput = page.getByPlaceholder('Store name')
    await storeInput.clear()
    await storeInput.fill('Costco Wholesale')

    // Save should become enabled
    const saveButton = page.getByRole('button', { name: /^Save$/i })
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    await saveButton.click()

    // Verify the payload
    expect(captured.body).toBeTruthy()
    expect(captured.body!.store_name).toBe('Costco Wholesale')
    expect(captured.body!.approve).toBe(false)
  })

  test('editing verified receipt date enables Save and sends correct payload', async ({ page }) => {
    const captured = mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByText('Costco')).toBeVisible()

    // Enter edit mode
    await page.getByRole('button', { name: /Edit/i }).click()

    // Change date
    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill('2026-03-01')

    // Save should become enabled
    const saveButton = page.getByRole('button', { name: /^Save$/i })
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    await saveButton.click()

    // Verify the payload
    expect(captured.body).toBeTruthy()
    expect(captured.body!.receipt_date).toBe('2026-03-01')
    expect(captured.body!.approve).toBe(false)
  })

  test('save draft (Save button) sends correct API call', async ({ page }) => {
    let savedBody: Record<string, unknown> | null = null
    await page.route(/\/api\/receipts\/3\/save/, route => {
      if (route.request().method() === 'POST') {
        savedBody = JSON.parse(route.request().postData() ?? '{}')
        return route.fulfill({ json: { status: 'ok' } })
      }
      return route.continue()
    })

    await page.goto('/receipts/3')

    // Wait for the page to finish loading
    await expect(page.getByText('Organic Bananas')).toBeVisible()

    // Make a change — update the store name to trigger dirty state
    const storeInput = page.getByPlaceholder('Store name')
    await storeInput.clear()
    await storeInput.fill('Costco Wholesale')

    // Wait for Save button to become enabled
    const saveButton = page.getByRole('button', { name: /^Save$/i })
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    // Click save
    await saveButton.click()

    // Should have sent a save request (not an approve)
    expect(savedBody).toBeTruthy()
    expect(savedBody!.approve).toBeFalsy()
  })

  test('approve receipt sends approve flag and navigates to receipts', async ({ page }) => {
    let savedBody: Record<string, unknown> | null = null
    await page.route(/\/api\/receipts\/3\/save/, route => {
      if (route.request().method() === 'POST') {
        savedBody = JSON.parse(route.request().postData() ?? '{}')
        return route.fulfill({ json: { status: 'ok' } })
      }
      return route.continue()
    })

    await page.goto('/receipts/3')
    await expect(page.getByText('Organic Bananas')).toBeVisible()

    // Click Approve
    const approveButton = page.getByRole('button', { name: /Approve/i })
    await expect(approveButton).toBeVisible({ timeout: 5000 })
    await approveButton.click()

    // Should have sent approve=true
    expect(savedBody).toBeTruthy()
    expect(savedBody!.approve).toBe(true)

    // Should navigate to receipts list
    await expect(page).toHaveURL(/\/receipts$/)
  })
})
