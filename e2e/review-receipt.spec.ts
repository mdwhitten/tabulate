import { test, expect, RECEIPT_DETAIL } from './fixtures'

/** Mock route that returns a verified receipt for id=1 and captures save requests. */
async function mockVerifiedReceipt(page: import('@playwright/test').Page) {
  const captured: { body: Record<string, unknown> | null } = { body: null }

  // Override single-receipt GET to return a verified receipt
  await page.route(/\/api\/receipts\/1$/, route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { ...RECEIPT_DETAIL, id: 1, status: 'verified' },
      })
    }
    return route.continue()
  })

  // Capture save body
  await page.route(/\/api\/receipts\/1\/save/, route => {
    if (route.request().method() === 'POST') {
      captured.body = JSON.parse(route.request().postData() ?? '{}')
      return route.fulfill({ json: { status: 'ok' } })
    }
    return route.continue()
  })

  return captured
}

test.describe('Review Receipt Page', () => {
  test('displays receipt details with all line items', async ({ page, isMobile }) => {
    await page.goto('/receipts/3')

    // Store name is an editable input for pending receipts (locked=false)
    await expect(page.getByPlaceholder('Store name')).toBeVisible()
    await expect(page.getByPlaceholder('Store name')).toHaveValue('Costco')

    // All items should be visible
    // Mobile renders item names as <p> text in cards; desktop renders as <input>
    for (const item of RECEIPT_DETAIL.items) {
      if (isMobile) {
        await expect(page.locator('.sm\\:hidden').getByText(item.clean_name, { exact: true })).toBeVisible()
      } else {
        await expect(page.locator(`input[value="${item.clean_name}"]`)).toBeVisible()
      }
    }
  })

  test('"All Receipts" back button navigates to receipts page', async ({ page }) => {
    await page.goto('/receipts/3')

    // Click the back button (identified by the ArrowLeft icon to avoid sidebar match)
    await page.locator('button:has(svg.lucide-arrow-left)').click()
    await expect(page).toHaveURL(/\/receipts$/)
  })

  test('pending receipt shows Approve button', async ({ page }) => {
    await page.goto('/receipts/3')

    // Wait for the review page to render and expose its state
    // The Approve button should be visible for a pending receipt
    // Use first() because topbar and footer both show Approve on desktop
    await expect(page.getByRole('button', { name: /Approve/i }).first()).toBeVisible({ timeout: 5000 })
  })

  test('verified receipt shows Edit button instead of Save/Approve', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'mobile uses pencil icon, not Edit button — see review-receipt-mobile.spec.ts')
    await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')

    // Edit button should be visible (locked mode) — first() for topbar + footer
    await expect(page.getByRole('button', { name: /Edit/i }).first()).toBeVisible({ timeout: 5000 })
  })

  test('clicking Edit on verified receipt unlocks store name and date', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'mobile uses pencil icon, not Edit button — see review-receipt-mobile.spec.ts')
    await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')

    // Wait for content to render
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Store name should be plain text (not an input) in locked mode
    await expect(page.getByPlaceholder('Store name')).not.toBeVisible()
    // Date input should be disabled
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeDisabled()

    // Click Edit — use first() since topbar and footer both show Edit on desktop
    await page.getByRole('button', { name: /Edit/i }).first().click()

    // Store name should now be an editable input
    await expect(page.getByPlaceholder('Store name')).toBeVisible()
    await expect(page.getByPlaceholder('Store name')).toBeEditable()

    // Date input should now be enabled
    await expect(dateInput).toBeEnabled()

    // Save button should appear (disabled until changes are made)
    await expect(page.getByRole('button', { name: /^Save$/i }).first()).toBeVisible()
    // Approve button should NOT appear (this is an edit, not a new review)
    await expect(page.getByRole('button', { name: /Approve/i })).not.toBeVisible()
  })

  test('editing verified receipt store name enables Save and sends correct payload', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'mobile uses pencil icon, not Edit button — see review-receipt-mobile.spec.ts')
    const captured = await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Enter edit mode — use first() since topbar and footer both show Edit
    await page.getByRole('button', { name: /Edit/i }).first().click()

    // Change store name
    const storeInput = page.getByPlaceholder('Store name')
    await storeInput.clear()
    await storeInput.fill('Costco Wholesale')

    // Save should become enabled — use first() for topbar + footer
    const saveButton = page.getByRole('button', { name: /^Save$/i }).first()
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    // Wait for save API call to complete before checking captured body
    const saveResponse = page.waitForResponse(resp => /\/api\/receipts\/\d+\/save/.test(resp.url()))
    await saveButton.click()
    await saveResponse

    // Verify the payload
    expect(captured.body).toBeTruthy()
    expect(captured.body!.store_name).toBe('Costco Wholesale')
    expect(captured.body!.approve).toBe(false)
  })

  test('editing verified receipt date enables Save and sends correct payload', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'mobile uses pencil icon, not Edit button — see review-receipt-mobile.spec.ts')
    const captured = await mockVerifiedReceipt(page)
    await page.goto('/receipts/1')
    await expect(page.getByRole('heading', { name: 'Costco' })).toBeVisible()

    // Enter edit mode — use first() since topbar and footer both show Edit
    await page.getByRole('button', { name: /Edit/i }).first().click()

    // Change date
    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill('2026-03-01')

    // Save should become enabled — use first() for topbar + footer
    const saveButton = page.getByRole('button', { name: /^Save$/i }).first()
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    // Wait for save API call to complete before checking captured body
    const saveResponse = page.waitForResponse(resp => /\/api\/receipts\/\d+\/save/.test(resp.url()))
    await saveButton.click()
    await saveResponse

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

    // Wait for the page to finish loading (mobile renders items as text, desktop as input)
    await expect(page.getByText('Subtotal').first()).toBeVisible()

    // Make a change — update the store name to trigger dirty state
    const storeInput = page.getByPlaceholder('Store name')
    await storeInput.clear()
    await storeInput.fill('Costco Wholesale')

    // Wait for Save button to become enabled — use first() for topbar + footer
    const saveButton = page.getByRole('button', { name: /^Save$/i }).first()
    await expect(saveButton).toBeEnabled({ timeout: 3000 })

    // Click save and wait for the API call to complete
    const saveResponse = page.waitForResponse(resp => /\/api\/receipts\/\d+\/save/.test(resp.url()))
    await saveButton.click()
    await saveResponse

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
    await expect(page.getByText('Subtotal').first()).toBeVisible()

    // Click Approve — use first() because topbar and footer both show Approve
    const approveButton = page.getByRole('button', { name: /Approve/i }).first()
    await expect(approveButton).toBeVisible({ timeout: 5000 })

    // Click approve and wait for the API call to complete
    const saveResponse = page.waitForResponse(resp => /\/api\/receipts\/\d+\/save/.test(resp.url()))
    await approveButton.click()
    await saveResponse

    // Should have sent approve=true
    expect(savedBody).toBeTruthy()
    expect(savedBody!.approve).toBe(true)

    // Should navigate to receipts list
    await expect(page).toHaveURL(/\/receipts$/)
  })
})
