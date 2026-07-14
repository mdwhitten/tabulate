import { test, expect, YNAB_CONFIG } from './fixtures'

test.describe('Settings — YNAB integration', () => {
  test('renders YNAB settings with token detected', async ({ page }) => {
    await page.goto('/settings')

    await expect(page.getByRole('heading', { name: 'YNAB' })).toBeVisible()
    await expect(page.getByText('YNAB access token detected')).toBeVisible()

    // Enable switch reflects the saved config (enabled)
    const toggle = page.getByRole('switch', { name: 'Enable YNAB sync' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // Budgets loaded into the select
    await expect(page.getByRole('option', { name: 'My Budget' })).toBeAttached()
  })

  test('loads budget-scoped accounts and categories', async ({ page }) => {
    await page.goto('/settings')

    // Accounts + categories for the pre-selected budget-1 are fetched
    // (category options appear in the default select and every mapping row)
    await expect(page.getByRole('option', { name: 'Checking' })).toBeAttached()
    await expect(page.getByRole('option', { name: 'Groceries (default)' }).first()).toBeAttached()
    await expect(page.getByRole('option', { name: 'Dining Out' }).first()).toBeAttached()
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

    // Change the account (2nd combobox: budget, account, default, then mappings)
    await page.getByRole('combobox').nth(1).selectOption('account-2')

    await page.getByRole('button', { name: /Save settings/i }).click()

    await expect(page.getByText('Saved')).toBeVisible()
    expect(putBody).not.toBeNull()
    expect(putBody.account_id).toBe('account-2')
    expect(putBody.enabled).toBe(true)
  })
})
