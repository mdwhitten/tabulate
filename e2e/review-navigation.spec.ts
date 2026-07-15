import { test, expect } from './fixtures'

test.describe('Receipts navigation & filtering', () => {
  test('receipts filter persists after opening a receipt and going back', async ({ page }) => {
    await page.goto('/receipts')

    await page.getByRole('button', { name: /^Pending$/i }).click()
    await expect(page.getByText('Costco')).toBeVisible()          // pending → shown
    await expect(page.getByText("Trader Joe's")).not.toBeVisible() // verified → hidden

    // Open a pending receipt, then go back
    await page.getByText('Costco').click()
    await expect(page).toHaveURL(/\/receipts\/\d+$/)
    await page.getByRole('button', { name: 'All receipts', exact: true }).click()

    // Filter is still Pending — verified receipts remain hidden
    await expect(page.getByText('Costco')).toBeVisible()
    await expect(page.getByText("Trader Joe's")).not.toBeVisible()
  })

  test('prev/next arrows step through the filtered list', async ({ page }) => {
    await page.goto('/receipts')
    await page.getByRole('button', { name: /^Pending$/i }).click()

    // Two pending receipts (Costco = pending, Safeway = review)
    await page.getByText('Costco').click()

    // First of two: prev disabled, position 1/2
    await expect(page.getByText('1/2')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Previous receipt' })).toBeDisabled()

    await page.getByRole('button', { name: 'Next receipt' }).click()

    // Second of two: next now disabled, position 2/2
    await expect(page.getByText('2/2')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next receipt' })).toBeDisabled()
  })

  test('auto-categorized-only filter hides learned/manual items', async ({ page, isMobile }) => {
    // Desktop renders item names in a table; mobile uses a separate card layout.
    // The filter logic is viewport-independent, so assert on the desktop layout.
    test.skip(!!isMobile, 'item name subtext is desktop-table specific')
    // RECEIPT_DETAIL: 4 items are AI-categorized, "Organic Strawberries" is learned.
    // Match on the raw-name subtext (rendered as visible <p>), which is unique per row.
    await page.goto('/receipts/3')

    await expect(page.getByText('ORG STRAWBERRIES')).toBeVisible()

    await page.getByRole('button', { name: /Auto-categorized only/i }).click()
    await expect(page.getByText('ORG STRAWBERRIES')).toHaveCount(0) // learned → hidden
    await expect(page.getByText('ORG BANANAS')).toBeVisible()       // ai → shown

    await page.getByRole('button', { name: /Auto-categorized only/i }).click()
    await expect(page.getByText('ORG STRAWBERRIES')).toBeVisible()
  })
})
