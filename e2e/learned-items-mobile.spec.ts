import { test, expect, MAPPINGS } from './fixtures'

test.describe('Learned Items — Mobile', () => {
  test.skip(({ isMobile, isEmbedded }) => !isMobile || isEmbedded, 'mobile-chrome only')

  test('last seen and times seen columns are hidden on mobile', async ({ page }) => {
    await page.goto('/learned')

    // Item names should be visible
    await expect(page.getByText('Organic Bananas')).toBeVisible()
    await expect(page.getByText('Whole Milk', { exact: true })).toBeVisible()

    // "Last Seen" column header should be hidden on mobile
    const lastSeenHeader = page.locator('th').filter({ hasText: 'Last Seen' })
    await expect(lastSeenHeader).toBeHidden()

    // "Times Seen" / "Seen" column header should be hidden on mobile
    const timesSeenHeader = page.locator('th').filter({ hasText: /Seen/i }).first()
    await expect(timesSeenHeader).toBeHidden()
  })

  test('search filters items on mobile', async ({ page }) => {
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

    await page.getByPlaceholder('Search items').fill('Banana')
    await expect(page.getByText('1 rule')).toBeVisible({ timeout: 2000 })
    await expect(page.getByText('Organic Bananas')).toBeVisible()
  })

  test('swipe left on item row reveals delete indicator', async ({ page }) => {
    let deleteCalled = false
    await page.route(/\/api\/items\/mappings\/\d+$/, route => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true
        return route.fulfill({ status: 200, json: { status: 'ok' } })
      }
      return route.continue()
    })

    await page.goto('/learned')
    await expect(page.getByText('Organic Bananas')).toBeVisible()

    // Find the first data row in the table
    const row = page.locator('table tbody tr').first()
    const box = await row.boundingBox()
    if (!box) throw new Error('Row not found')

    // Perform a swipe-left gesture (start right, drag left past 80px threshold)
    const startX = box.x + box.width - 20
    const startY = box.y + box.height / 2

    await page.touchscreen.tap(startX, startY)
    // Simulate a swipe: touch start, move left, release
    await row.dispatchEvent('touchstart', {
      touches: [{ clientX: startX, clientY: startY, identifier: 0 }],
    })
    // Move past threshold (80px) in small steps
    for (let dx = 0; dx <= 120; dx += 20) {
      await row.dispatchEvent('touchmove', {
        touches: [{ clientX: startX - dx, clientY: startY, identifier: 0 }],
      })
    }
    await row.dispatchEvent('touchend', {
      changedTouches: [{ clientX: startX - 120, clientY: startY, identifier: 0 }],
    })

    // Wait for delete animation and API call
    await page.waitForTimeout(500)
    expect(deleteCalled).toBe(true)
  })

  test('category filter chips work on mobile', async ({ page }) => {
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

    await page.getByRole('button', { name: /Produce/i }).first().click()
    await expect(page.getByText('1 rule')).toBeVisible({ timeout: 2000 })
  })
})
