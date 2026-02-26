import { test, expect, CATEGORIES } from './fixtures'

test.describe('Categories Management', () => {
  test('displays all active categories', async ({ page }) => {
    await page.goto('/categories')

    // All non-disabled built-in categories should be visible
    for (const cat of CATEGORIES.filter(c => !c.is_disabled)) {
      await expect(page.getByText(cat.name, { exact: true }).first()).toBeVisible()
    }

    // Built-in badges visible
    const builtInBadges = page.getByText('Built-in')
    await expect(builtInBadges.first()).toBeVisible()
  })

  test('create a new custom category', async ({ page }) => {
    const newCat = { id: 100, name: 'Organic', icon: '🥬', color: '#7ab04f', is_builtin: false, is_disabled: false, sort_order: 100 }

    // Intercept the create POST
    await page.route('**/api/categories', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, json: newCat })
      }
      // GET returns updated list including the new one
      return route.fulfill({ json: [...CATEGORIES, newCat] })
    })

    await page.goto('/categories')

    // Click "New Category"
    await page.getByRole('button', { name: /New Category/i }).click()

    // The edit row should appear with a name input
    const nameInput = page.getByPlaceholder('Category name')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toBeFocused()

    // Type a name
    await nameInput.fill('Organic')

    // Pick a color swatch
    await page.locator('button[title="#4f7ab0"]').click()

    // Click Create
    await page.getByRole('button', { name: /Create/i }).click()

    // After creation, the new category should appear
    await expect(page.getByText('Organic')).toBeVisible()
  })

  test('edit a custom category name', async ({ page }) => {
    const customCat = { id: 100, name: 'Organic', icon: '🥬', color: '#7ab04f', is_builtin: false, is_disabled: false, sort_order: 100 }
    const allCats = [...CATEGORIES, customCat]

    await page.route('**/api/categories', route =>
      route.fulfill({ json: allCats }),
    )
    await page.route(/\/api\/categories\/100$/, route => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({ json: { ...customCat, name: 'Organic Foods' } })
      }
      return route.continue()
    })

    await page.goto('/categories')

    // Find the Edit button for the custom category
    const customRow = page.locator('div').filter({ hasText: /^.*Organic.*Custom/ }).first()
    await customRow.getByRole('button', { name: /Edit/i }).click()

    // Modify name
    const nameInput = page.getByPlaceholder('Category name')
    await nameInput.clear()
    await nameInput.fill('Organic Foods')

    // Save
    await page.getByRole('button', { name: /^Save$/i }).click()
  })

  test('disable and re-enable a built-in category', async ({ page }) => {
    let categoriesState = [...CATEGORIES]

    await page.route('**/api/categories', route =>
      route.fulfill({ json: categoriesState }),
    )
    await page.route(/\/api\/categories\/\d+$/, async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = JSON.parse(route.request().postData() ?? '{}')
        const url = route.request().url()
        const id = Number(url.match(/\/categories\/(\d+)$/)?.[1])
        const cat = categoriesState.find(c => c.id === id)
        if (cat) {
          cat.is_disabled = body.is_disabled ?? cat.is_disabled
        }
        return route.fulfill({ json: cat })
      }
      return route.continue()
    })

    await page.goto('/categories')

    // Disable the "Bakery" category
    const bakeryRow = page.locator('div').filter({ hasText: /^.*Bakery.*Built-in/ }).first()
    await bakeryRow.getByRole('button', { name: /Disable/i }).click()

    // After disable, the "Disabled" section should appear
    await expect(page.getByText('Disabled')).toBeVisible()

    // Re-enable it
    await page.getByRole('button', { name: /Enable/i }).click()
  })

  test('"New Category" button is disabled while form is open', async ({ page }) => {
    await page.goto('/categories')

    const newBtn = page.getByRole('button', { name: /New Category/i })
    await newBtn.click()

    // Button should now be disabled
    await expect(newBtn).toBeDisabled()

    // Cancel the form
    await page.getByRole('button', { name: /Cancel/i }).click()

    // Button should be enabled again
    await expect(newBtn).toBeEnabled()
  })
})
