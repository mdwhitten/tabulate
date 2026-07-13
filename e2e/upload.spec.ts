import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function processingResult(id: number) {
  return {
    receipt_id: id,
    store_name: `Store ${id}`,
    receipt_date: '2026-02-15',
    ocr_raw: 'MOCK',
    subtotal: 10,
    tax: 1,
    discounts: 0,
    total: 11,
    total_verified: true,
    verification_message: 'Total matches sum of items.',
    thumbnail_path: null,
    categorization_failed: false,
    items: [],
  }
}

/**
 * Mock the upload endpoint (distinct receipt per call) and block the vendored
 * OpenCV/jscanify scripts so the client scanner fails fast and the flow falls
 * back to uploading the original image — deterministic in headless.
 */
async function mockUploadFlow(page: Page) {
  let nextId = 1001
  await page.route('**/vendor/opencv.js', route => route.abort())
  await page.route('**/vendor/jscanify.js', route => route.abort())
  await page.route('**/api/receipts/detect-edges-raw', route =>
    route.fulfill({ json: { corners: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]] } }),
  )
  await page.route('**/api/receipts/upload', route =>
    route.fulfill({ json: processingResult(nextId++) }),
  )
}

test.describe('Upload flow', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop-only flow')
  })

  test('multi-upload processes a batch and Approve advances through the queue', async ({ page }) => {
    await mockUploadFlow(page)
    await page.goto('/')

    // "Scan Receipt" matches both the sidebar button and the topbar action.
    await page.getByRole('button', { name: 'Scan Receipt' }).first().click()

    // Queue two images.
    await page.locator('input[type="file"][multiple]').setInputFiles([
      { name: 'a.png', mimeType: 'image/png', buffer: PNG },
      { name: 'b.png', mimeType: 'image/png', buffer: PNG },
    ])

    await expect(page.getByRole('button', { name: /Process 2 receipts/ })).toBeVisible()
    await page.getByRole('button', { name: /Process 2 receipts/ }).click()

    // Review opens on the first with an "n of m" indicator.
    await expect(page.getByText(/1 of 2/)).toBeVisible()

    // Approve advances to the next in the queue (footer button, exact match to
    // avoid the topbar "Approve & Next").
    const approve = () => page.getByRole('button', { name: 'Approve', exact: true }).first()
    await approve().click()
    await expect(page.getByText(/2 of 2/)).toBeVisible()

    // Final approve returns to the receipts list.
    await approve().click()
    await expect(page).toHaveURL(/\/receipts$/)
  })

  test('single upload goes through the crop step and opens review', async ({ page }) => {
    await mockUploadFlow(page)
    await page.goto('/')

    await page.getByRole('button', { name: 'Scan Receipt' }).first().click()

    await page.locator('input[type="file"][multiple]').setInputFiles([
      { name: 'only.png', mimeType: 'image/png', buffer: PNG },
    ])

    await page.getByRole('button', { name: /Process 1 receipt/ }).click()

    // Single image → crop modal; skipping uploads the full image.
    await page.getByRole('button', { name: /Skip — Use Full Image/ }).click()

    // Lands on review with no batch indicator.
    await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
    await expect(page.getByText(/\d+ of \d+/)).toHaveCount(0)
  })
})
