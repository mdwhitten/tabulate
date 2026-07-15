import { test, expect, YNAB_CONFIG } from './fixtures'

test.describe('Settings — YNAB integration', () => {
  test('renders YNAB settings with token detected', async ({ page }) => {
    await page.goto('/settings')

    await expect(page.getByRole('heading', { name: 'YNAB' })).toBeVisible()
    await expect(page.getByText('YNAB access token detected')).toBeVisible()

    // Enable switch reflects the saved config (enabled)
    const toggle = page.getByRole('switch', { name: 'Enable YNAB sync' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // The searchable selects show the saved values on their triggers
    await expect(page.getByRole('button', { name: 'My Budget' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Checking' })).toBeVisible()
  })

  test('budget dropdown opens and lists budgets', async ({ page }) => {
    await page.goto('/settings')

    await page.getByRole('button', { name: 'My Budget' }).click()
    // Both budgets appear as options in the portal dropdown
    await expect(page.getByRole('button', { name: 'Household' })).toBeVisible()
  })

  test('default-category dropdown supports built-in search', async ({ page }) => {
    await page.goto('/settings')

    // Open the default-category select (trigger shows the saved default)
    await page.getByRole('button', { name: 'Groceries (default)' }).click()

    // With >5 categories the search box is shown
    const search = page.getByPlaceholder('Search categories…')
    await expect(search.first()).toBeVisible()
    await search.first().fill('Dining')

    // Only the matching option remains
    await expect(page.getByRole('button', { name: 'Dining Out' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Utilities' })).toHaveCount(0)
  })

  test('saves configuration changes', async ({ page }) => {
    let putBody: any = null
    await page.route(/\/api\/ynab\/config$/, async route => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON()
        return route.fulfill({ json: YNAB_CONFIG })
      }
      return route.fulfill({ json: YNAB_CONFIG })
    })

    await page.goto('/settings')

    // Change the account via the searchable dropdown
    await page.getByRole('button', { name: 'Checking' }).click()
    await page.getByRole('button', { name: 'Credit Card' }).click()

    await page.getByRole('button', { name: /Save settings/i }).click()

    await expect(page.getByText('Saved')).toBeVisible()
    expect(putBody).not.toBeNull()
    expect(putBody.account_id).toBe('account-2')
    expect(putBody.enabled).toBe(true)
  })
})
