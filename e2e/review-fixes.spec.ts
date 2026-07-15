import { test, expect, RECEIPT_DETAIL } from './fixtures'

test.describe('Review Receipt — bug fixes', () => {
  test('manual total field accepts a full multi-digit number', async ({ page }) => {
    // A receipt with no total puts the verify bar in the "fail" state, which
    // shows the manual-total input. Regression: typing "300" used to commit "3"
    // on the first keystroke and unmount the field.
    await page.route(/\/api\/receipts\/3$/, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: { ...RECEIPT_DETAIL, id: 3, status: 'pending', total: null, total_verified: false,
                  verification_message: 'Could not read receipt total.' },
        })
      }
      return route.continue()
    })

    await page.goto('/receipts/3')

    const totalInput = page.getByPlaceholder('0.00')
    await expect(totalInput).toBeVisible()

    // Type digit-by-digit; the field must retain the full value, not commit early
    await totalInput.click()
    await totalInput.pressSequentially('300')
    await expect(totalInput).toHaveValue('300')

    // Committing on blur applies 300 as the total (verify bar now shows it)
    await totalInput.blur()
    await expect(page.getByText(/\$300\.00/)).toBeVisible()
  })

  test('re-sync is blocked while there are unsaved edits', async ({ page }) => {
    await page.route(/\/api\/receipts\/3$/, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: { ...RECEIPT_DETAIL, id: 3, status: 'verified', total_verified: true,
                  ynab_sync_status: 'synced', ynab_transaction_id: null },
        })
      }
      return route.continue()
    })

    await page.goto('/receipts/3')

    // YNAB row is shown for a verified receipt when the integration is enabled
    const syncButton = page.getByRole('button', { name: 'Sync to YNAB' })
    await expect(syncButton).toBeEnabled()

    // Enter edit mode and make a change (footer Edit button, in the main region)
    await page.getByRole('main').getByRole('button', { name: 'Edit' }).click()
    const storeInput = page.getByPlaceholder('Store name')
    await storeInput.fill('Edited Store')

    // Sync is now blocked with a hint until the change is saved
    await expect(page.getByText('Unsaved changes — save to sync')).toBeVisible()
    await expect(syncButton).toBeDisabled()
  })
})
