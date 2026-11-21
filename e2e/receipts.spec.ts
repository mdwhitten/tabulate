import { test, expect, RECEIPTS } from './fixtures'

test.describe('All Receipts Page', () => {
  test('displays receipt table with all receipts', async ({ page }) => {
    await page.goto('/receipts')

    // All store names should be visible
    await expect(page.getByText('Whole Foods').first()).toBeVisible()
    await expect(page.getByText('Trader Joe\'s')).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
    await expect(page.getByText('Safeway')).toBeVisible()
    await expect(page.getByText('Target')).toBeVisible()

    // Receipt count shown
    await expect(page.getByText(`${RECEIPTS.length} receipts`)).toBeVisible()
  })

  test('search filters receipts by store name', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('Whole Foods')

    // Only Whole Foods receipts should be visible (2 of them)
    await expect(page.getByText('2 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).not.toBeVisible()
    await expect(page.getByText('Trader Joe\'s')).not.toBeVisible()
  })

  test('search filters receipts by date', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('2026-02-15')

    // Only the Costco receipt from Feb 15 should match
    await expect(page.getByText('1 receipt')).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
  })

  test('status filter chips filter by status', async ({ page }) => {
    await page.goto('/receipts')

    // Click "Approved" chip
    await page.getByRole('button', { name: /^Approved$/i }).click()

    // Should show only verified receipts (4: ids 1, 2, 5, 6)
    await expect(page.getByText('4 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).not.toBeVisible()   // pending
    await expect(page.getByText('Safeway')).not.toBeVisible()  // review
    await expect(page.getByText('Whole Foods').first()).toBeVisible()

    // Click "Pending" chip
    await page.getByRole('button', { name: /^Pending$/i }).click()

    // Should show non-verified receipts (2: ids 3, 4)
    await expect(page.getByText('2 receipts')).toBeVisible()
    await expect(page.getByText('Costco')).toBeVisible()
    await expect(page.getByText('Safeway')).toBeVisible()

    // Click "All" chip
    await page.getByRole('button', { name: /^All$/i }).click()
    await expect(page.getByText(`${RECEIPTS.length} receipts`)).toBeVisible()
  })

  test('clicking a receipt row opens review page', async ({ page }) => {
    await page.goto('/receipts')

    // Click Costco row
    await page.getByText('Costco').click()
    await expect(page).toHaveURL(/\/receipts\/3$/)

    // Review page should load
    await expect(page.getByPlaceholder('Store name')).toBeVisible()
  })

  test('empty search shows "No receipts found" message', async ({ page }) => {
    await page.goto('/receipts')

    const searchInput = page.getByPlaceholder('Search store or date')
    await searchInput.fill('nonexistent store xyz')

    await expect(page.getByText('No receipts found')).toBeVisible()
    await expect(page.getByText('0 receipts')).toBeVisible()
  })

  test('search and status filters combine correctly', async ({ page }) => {
    await page.goto('/receipts')

    // Search for "Whole" + filter to Approved
    await page.getByPlaceholder('Search store or date').fill('Whole')
    await page.getByRole('button', { name: /^Approved$/i }).click()

    // Both Whole Foods receipts are verified → 2 results
    await expect(page.getByText('2 receipts')).toBeVisible()

    // Switch to Pending with same search
    await page.getByRole('button', { name: /^Pending$/i }).click()
    await expect(page.getByText('0 receipts')).toBeVisible()
    await expect(page.getByText('No receipts found')).toBeVisible()
  })
})

test.describe('Receipts still being processed', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop layout')
  })

  const summary = (id: number, status: string, over: Record<string, unknown> = {}) => ({
    id, store_name: 'Unknown Store', receipt_date: null, scanned_at: '2026-02-21T10:00:00Z',
    status, total: null, item_count: 0, total_verified: false, ...over,
  })

  test('are listed with their own badge and become reviewable when done', async ({ page }) => {
    let done = false
    await page.route('**/api/receipts', route => {
      if (route.request().method() !== 'GET') return route.fallback()
      return route.fulfill({
        json: [
          done
            ? summary(50, 'pending', { store_name: 'ALDI', receipt_date: '2026-02-21', total: 6.49, item_count: 2 })
            : summary(50, 'processing'),
          summary(51, 'failed'),
        ],
      })
    })
    await page.goto('/receipts')

    const processing = page.getByRole('row').filter({ hasText: 'Processing…' })
    await expect(processing).toHaveCount(1)
    await expect(processing).toContainText('New receipt')
    await expect(page.getByRole('row').filter({ hasText: 'Failed' })).toHaveCount(1)

    // The list keeps itself fresh while something is processing.
    done = true
    await expect(page.getByRole('row').filter({ hasText: 'ALDI' })).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'Processing…' })).toHaveCount(0)
  })

  test('opening one waits for it instead of showing an empty review', async ({ page }) => {
    let status = 'processing'
    await page.route(/\/api\/receipts\/50$/, route => {
      if (route.request().method() !== 'GET') return route.fallback()
      return route.fulfill({
        json: {
          id: 50, store_name: status === 'processing' ? '' : 'ALDI', receipt_date: '2026-02-21',
          scanned_at: '2026-02-21T10:00:00Z', status, total: 6.49, tax: 0.5, total_verified: true,
          ocr_raw: null, image_path: null, thumbnail_path: null, processing_error: null,
          items: status === 'processing' ? [] : [{
            id: 1, receipt_id: 50, raw_name: 'BANANAS', clean_name: 'Bananas',
            category: 'Produce', category_source: 'ai', price: 1.99, quantity: 1,
          }],
        },
      })
    })
    await page.goto('/receipts/50')
    await expect(page.getByTestId('receipt-processing')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)

    status = 'pending'
    await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('receipt-processing')).toHaveCount(0)
  })

  test('a failed one shows the reason and can be retried', async ({ page }) => {
    let status = 'failed'
    let reprocessed = 0
    await page.route(/\/api\/receipts\/51$/, route => {
      if (route.request().method() !== 'GET') return route.fallback()
      return route.fulfill({
        json: {
          id: 51, store_name: '', receipt_date: null, scanned_at: '2026-02-21T10:00:00Z', status,
          total: null, tax: null, total_verified: false, ocr_raw: null, image_path: null,
          thumbnail_path: null, processing_error: 'OCR failed (ValueError): unreadable', items: [],
        },
      })
    })
    await page.route(/\/api\/receipts\/51\/reprocess$/, route => {
      reprocessed++
      status = 'processing'
      return route.fulfill({ status: 202, json: { receipt_id: 51, status: 'processing' } })
    })
    await page.goto('/receipts/51')

    await expect(page.getByTestId('receipt-failed')).toContainText('OCR failed (ValueError): unreadable')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('receipt-processing')).toBeVisible()
    expect(reprocessed).toBe(1)
  })
})
