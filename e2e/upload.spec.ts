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

/** Server-sent events body, as the backend writes it: one `data:` line per event. */
const sse = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')

/** A full progress stream ending with the processing result. */
function uploadStreamBody(id: number) {
  return sse([
    { type: 'progress', stage: 'preparing' },
    { type: 'progress', stage: 'reading', method: 'ai' },
    { type: 'progress', stage: 'reading', method: 'ai', items: 2 },
    { type: 'progress', stage: 'checking' },
    { type: 'progress', stage: 'categorizing' },
    { type: 'progress', stage: 'saving' },
    { type: 'result', data: processingResult(id) },
  ])
}

/**
 * Block the vendored OpenCV/jscanify scripts so the client scanner fails fast
 * and the flow falls back to uploading the original image — deterministic in
 * headless — and mock edge detection.
 */
async function mockScanner(page: Page) {
  await page.route('**/vendor/opencv.js', route => route.abort())
  await page.route('**/vendor/jscanify.js', route => route.abort())
  await page.route('**/api/receipts/detect-edges-raw', route =>
    route.fulfill({ json: { corners: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]] } }),
  )
}

/** Mock the streaming upload endpoint (distinct receipt per call). */
async function mockUploadFlow(page: Page) {
  let nextId = 1001
  await mockScanner(page)
  await page.route('**/api/receipts/upload-stream', route =>
    route.fulfill({ contentType: 'text/event-stream', body: uploadStreamBody(nextId++) }),
  )
}

/**
 * Playwright's route.fulfill delivers a body all at once, so to observe live
 * progress we replace fetch for the upload-stream URL with a ReadableStream the
 * test pushes NDJSON lines into via `pushUploadLine`.
 */
// Shape of the page globals the controllable stream shim uses. (The e2e
// tsconfig has no DOM lib, so this goes through globalThis.)
type StreamGlobals = {
  __uploadStream?: ReadableStreamDefaultController<Uint8Array>
  fetch: typeof fetch
}

async function mockControllableUploadStream(page: Page) {
  await mockScanner(page)
  await page.addInitScript(() => {
    const g = globalThis as unknown as StreamGlobals
    const realFetch = g.fetch.bind(g)
    g.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/receipts/upload-stream')) {
        const body = new ReadableStream<Uint8Array>({ start(c) { g.__uploadStream = c } })
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
      }
      return realFetch(input, init)
    }
  })
}

async function pushUploadLine(page: Page, event: unknown, close = false) {
  await page.waitForFunction(() => !!(globalThis as unknown as StreamGlobals).__uploadStream)
  await page.evaluate(([line, end]) => {
    const c = (globalThis as unknown as StreamGlobals).__uploadStream!
    c.enqueue(new TextEncoder().encode(line))
    if (end) c.close()
  }, [`data: ${JSON.stringify(event)}\n\n`, close] as const)
}

/** Open the modal, queue one image and skip the crop step to start uploading. */
async function startSingleUpload(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Scan Receipt' }).first().click()
  await page.locator('input[type="file"][multiple]').setInputFiles([
    { name: 'only.png', mimeType: 'image/png', buffer: PNG },
  ])
  await page.getByRole('button', { name: /Process 1 receipt/ }).click()
  await page.getByRole('button', { name: /Skip — Use Full Image/ }).click()
}

test.describe('Upload flow', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
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

    // Each receipt steps through the crop modal (auto-detected corners pre-filled).
    await expect(page.getByText('Crop Receipt')).toBeVisible()
    await page.getByRole('button', { name: /Apply Crop/ }).click()   // receipt 1
    await page.getByRole('button', { name: /Apply Crop/ }).click()   // receipt 2

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

  test('single upload shows real progress streamed from the server', async ({ page }) => {
    await mockControllableUploadStream(page)
    await startSingleUpload(page)

    const steps = page.getByTestId('processing-steps')
    const active = steps.locator('[aria-current="step"]')

    // Nothing streamed yet: still uploading.
    await expect(active).toContainText('Uploading image')

    await pushUploadLine(page, { type: 'progress', stage: 'preparing' })
    await expect(active).toContainText('Preparing image')

    await pushUploadLine(page, { type: 'progress', stage: 'reading', method: 'ai' })
    await expect(active).toContainText('Reading receipt with AI')

    await pushUploadLine(page, { type: 'progress', stage: 'reading', method: 'ai', items: 23 })
    await expect(active).toContainText('23 items found')

    await pushUploadLine(page, { type: 'progress', stage: 'rechecking', problems: 1 })
    await expect(active).toContainText('Double-checking totals…')

    // Unknown stages are ignored.
    await pushUploadLine(page, { type: 'progress', stage: 'warp-drive' })
    await expect(active).toContainText('Double-checking totals…')

    await pushUploadLine(page, { type: 'progress', stage: 'categorizing' })
    await expect(active).toContainText('Categorizing & saving')

    await pushUploadLine(page, { type: 'result', data: processingResult(2001) }, true)
    await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
  })

  test('single upload labels the OCR fallback', async ({ page }) => {
    await mockControllableUploadStream(page)
    await startSingleUpload(page)

    await pushUploadLine(page, { type: 'progress', stage: 'preparing' })
    await pushUploadLine(page, { type: 'progress', stage: 'reading', method: 'ocr' })
    await expect(page.getByTestId('processing-steps').locator('[aria-current="step"]'))
      .toContainText('Reading receipt (OCR)')
  })

  test('a streamed error event shows the message and returns to the picker', async ({ page }) => {
    await mockScanner(page)
    await page.route('**/api/receipts/upload-stream', route =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: sse([
          { type: 'progress', stage: 'preparing' },
          { type: 'error', status: 422, detail: 'Could not read receipt' },
        ]),
      }),
    )
    await startSingleUpload(page)

    await expect(page.getByText('Upload failed: Could not read receipt')).toBeVisible()
    await expect(page.getByRole('button', { name: /Process 1 receipt/ })).toBeVisible()
  })
})
