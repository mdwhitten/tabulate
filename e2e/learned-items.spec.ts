import { test, expect, MAPPINGS } from './fixtures'

test.describe('Learned Items Page', () => {
  test('displays learned items table', async ({ page }) => {
    await page.goto('/learned')

    // All mapped items should be visible
    for (const item of MAPPINGS.items) {
      await expect(page.getByText(item.display_name)).toBeVisible()
    }

    // Total rule count
    await expect(page.getByText(`${MAPPINGS.total} rules`)).toBeVisible()
  })

  test('search filters items by name', async ({ page }) => {
    const filteredMappings = {
      items: MAPPINGS.items.filter(m => m.display_name.toLowerCase().includes('banana')),
      total: 1,
    }

    await page.route('**/api/items/mappings?*', route => {
      const url = new URL(route.request().url())
      const search = url.searchParams.get('search')
      if (search && search.toLowerCase().includes('banana')) {
        return route.fulfill({ json: filteredMappings })
      }
      return route.fulfill({ json: MAPPINGS })
    })

    await page.goto('/learned')

    const searchInput = page.getByPlaceholder('Search items')
    await searchInput.fill('Banana')

    // Wait for debounced search (300ms)
    await expect(page.getByText('1 rule')).toBeVisible({ timeout: 2000 })
    await expect(page.getByText('Organic Bananas')).toBeVisible()
  })

  test('category filter chips filter by category', async ({ page }) => {
    const produceMappings = {
      items: MAPPINGS.items.filter(m => m.category === 'Produce'),
      total: 1,
    }

    await page.route('**/api/items/mappings?*', route => {
      const url = new URL(route.request().url())
      const category = url.searchParams.get('category')
      if (category === 'Produce') {
        return route.fulfill({ json: produceMappings })
      }
      return route.fulfill({ json: MAPPINGS })
    })

    await page.goto('/learned')

    // Click the "Produce" filter chip — use first() because CategorySelect
    // buttons in the table also contain the same category text
    await page.getByRole('button', { name: /Produce/i }).first().click()

    // Should show only Produce items
    await expect(page.getByText('1 rule')).toBeVisible({ timeout: 2000 })
  })

  test('category dropdown changes item category', async ({ page }) => {
    let patchCalled = false
    await page.route(/\/api\/items\/mappings\/\d+\/category$/, route => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true
        return route.fulfill({
          json: { status: 'ok', mapping_id: 1, category: 'Snacks' },
        })
      }
      return route.continue()
    })

    await page.goto('/learned')

    // The CategorySelect is a custom button dropdown, not a native <select>.
    // Click the first category button to open the dropdown, then select "Snacks".
    const firstCategoryBtn = page.locator('table button').filter({ hasText: 'Produce' }).first()
    await firstCategoryBtn.click()

    // Pick "Snacks" from the portal dropdown (rendered at z-index 9999)
    // Use the portal container to avoid matching the filter chip button
    await page.locator('[style*="z-index: 9999"] button').filter({ hasText: 'Snacks' }).click()

    // The PATCH call should have been made
    expect(patchCalled).toBe(true)
  })

  test('empty state shown when no items', async ({ page }) => {
    await page.route('**/api/items/mappings*', route =>
      route.fulfill({ json: { items: [], total: 0 } }),
    )

    await page.goto('/learned')
    await expect(page.getByText('No learned items found')).toBeVisible()
  })

  test('source tags displayed correctly', async ({ page }) => {
    await page.goto('/learned')

    // Source tags render with emojis: "✓ Learned", "🤖 AI", "✏️ Manual"
    await expect(page.getByText('Learned').first()).toBeVisible()
    await expect(page.getByText('AI').first()).toBeVisible()
    await expect(page.getByText('Manual').first()).toBeVisible()
  })
})
