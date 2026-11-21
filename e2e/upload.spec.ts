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

// ── Fake server ──────────────────────────────────────────────────────────────
// Uploads are accepted first (POST /enqueue → receipt id) and processed in the
// background; the UI follows them by polling GET /status?ids=…. This fake
// keeps each receipt's state in the test process so a test can drive it.

type Progress = { stage: string; method?: string; items?: number; problems?: number }
type FakeState =
  | { status: 'processing'; progress: Progress }
  | { status: 'failed'; error: string }
  | { status: 'pending'; result: ReturnType<typeof processingResult> | null }

interface FakeServer {
  /** Receipt ids accepted so far, in order. */
  enqueued: number[]
  /** Receipt ids sent for another attempt. */
  reprocessed: number[]
  deleted: number[]
  progress(id: number, progress: Progress): void
  finish(id: number): void
  fail(id: number, error: string): void
}

/**
 * Mock the upload endpoints. With `autoFinish` (default) every receipt is ready
 * on the first poll; otherwise it stays "queued" until the test moves it on.
 */
async function mockServer(page: Page, { autoFinish = true, firstId = 1001 } = {}): Promise<FakeServer> {
  await mockScanner(page)
  const states = new Map<number, FakeState>()
  let nextId = firstId
  const server: FakeServer = {
    enqueued: [],
    reprocessed: [],
    deleted: [],
    progress: (id, progress) => { states.set(id, { status: 'processing', progress }) },
    finish: id => { states.set(id, { status: 'pending', result: processingResult(id) }) },
    fail: (id, error) => { states.set(id, { status: 'failed', error }) },
  }

  await page.route('**/api/receipts/enqueue', route => {
    const id = nextId++
    server.enqueued.push(id)
    if (autoFinish) server.finish(id)
    else server.progress(id, { stage: 'queued' })
    return route.fulfill({ status: 202, json: { receipt_id: id, status: 'processing' } })
  })

  await page.route('**/api/receipts/status?*', route => {
    const ids = (new URL(route.request().url()).searchParams.get('ids') ?? '').split(',').map(Number)
    const body = ids.filter(id => states.has(id)).map(id => {
      const st = states.get(id)!
      return {
        id,
        status: st.status,
        progress: st.status === 'processing' ? st.progress : null,
        error: st.status === 'failed' ? st.error : null,
        result: st.status === 'pending' ? st.result : null,
      }
    })
    return route.fulfill({ json: body })
  })

  await page.route(/\/api\/receipts\/\d+\/reprocess$/, route => {
    const id = Number(route.request().url().match(/\/receipts\/(\d+)\/reprocess$/)![1])
    server.reprocessed.push(id)
    server.progress(id, { stage: 'queued' })
    return route.fulfill({ status: 202, json: { receipt_id: id, status: 'processing' } })
  })

  await page.route(/\/api\/receipts\/\d+$/, route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const id = Number(route.request().url().match(/\/receipts\/(\d+)$/)![1])
    server.deleted.push(id)
    states.delete(id)
    return route.fulfill({ status: 204 })
  })

  return server
}

async function pickFiles(page: Page, names: string[]) {
  await page.goto('/')
  // "Scan Receipt" matches both the sidebar button and the topbar action.
  await page.getByRole('button', { name: 'Scan Receipt' }).first().click()
  await page.locator('input[type="file"][multiple]').setInputFiles(
    names.map(name => name.endsWith('.pdf')
      ? { name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }
      : { name, mimeType: 'image/png', buffer: PNG }),
  )
  await page.getByRole('button', { name: new RegExp(`Process ${names.length} receipt`) }).click()
}

/** Open the modal, queue one image and skip the crop step to start uploading. */
async function startSingleUpload(page: Page) {
  await pickFiles(page, ['only.png'])
  await page.getByRole('button', { name: /Skip — Use Full Image/ }).click()
}

const approve = (page: Page) => page.getByRole('button', { name: 'Approve', exact: true }).first()

test.describe('Upload flow', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'desktop-only flow')
  })

  test('multi-upload processes a batch and Approve advances through the queue', async ({ page }) => {
    const server = await mockServer(page)
    await pickFiles(page, ['a.png', 'b.png'])

    // Each receipt steps through the crop modal (auto-detected corners pre-filled).
    await expect(page.getByText('Crop Receipt')).toBeVisible()
    await page.getByRole('button', { name: /Apply Crop/ }).click()   // receipt 1
    await page.getByRole('button', { name: /Apply Crop/ }).click()   // receipt 2

    // Review opens on the first with an "n of m" indicator.
    await expect(page.getByText(/1 of 2/)).toBeVisible()
    expect(server.enqueued).toEqual([1001, 1002])

    // Approve advances to the next in the queue (footer button, exact match to
    // avoid the topbar "Approve & Next").
    await approve(page).click()
    await expect(page.getByText(/2 of 2/)).toBeVisible()

    // Final approve returns to the receipts list.
    await approve(page).click()
    await expect(page).toHaveURL(/\/receipts$/)
  })

  test('each receipt is uploaded as soon as its crop is confirmed', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    await pickFiles(page, ['a.png', 'doc.pdf', 'b.png'])

    // The PDF needs no crop, so it is already on its way while the first photo is cropped.
    await expect(page.getByText('Crop Receipt')).toBeVisible()
    await expect.poll(() => server.enqueued.length).toBe(1)

    await page.getByRole('button', { name: /Apply Crop/ }).click()
    // First photo sent; the second is still waiting in the crop step.
    await expect.poll(() => server.enqueued.length).toBe(2)
    await expect(page.getByText('Crop Receipt')).toBeVisible()

    await page.getByRole('button', { name: /Apply Crop/ }).click()
    await expect.poll(() => server.enqueued.length).toBe(3)

    // All three are listed with their own state.
    const rows = page.getByTestId('upload-row')
    await expect(rows).toHaveCount(3)
    await expect(page.getByText('Processing receipts… 0 of 3 ready')).toBeVisible()
    await expect(rows.filter({ hasText: 'Waiting to start' })).toHaveCount(3)

    server.progress(1002, { stage: 'reading', method: 'ai', items: 4 })
    await expect(rows.filter({ hasText: 'Reading receipt with AI · 4 items found' })).toHaveCount(1)

    server.finish(1001)
    await expect(page.getByText('Processing receipts… 1 of 3 ready')).toBeVisible()
    await expect(rows.filter({ hasText: 'Ready to review' })).toHaveCount(1)

    // Once the rest finish, review starts on its own.
    server.finish(1002)
    server.finish(1003)
    await expect(page.getByText(/1 of 3/)).toBeVisible()
  })

  test('single upload goes through the crop step and opens review', async ({ page }) => {
    await mockServer(page)
    await startSingleUpload(page)

    // Lands on review with no batch indicator.
    await expect(approve(page)).toBeVisible()
    await expect(page.getByText(/\d+ of \d+/)).toHaveCount(0)
  })

  test('single upload shows the real processing stage', async ({ page }) => {
    test.setTimeout(30_000)   // several one-second polls
    const server = await mockServer(page, { autoFinish: false, firstId: 2001 })
    await startSingleUpload(page)

    const active = page.getByTestId('processing-steps').locator('[aria-current="step"]')

    // Accepted and waiting for a worker: past "Uploading image".
    await expect(active).toContainText('Preparing image')

    server.progress(2001, { stage: 'reading', method: 'ai' })
    await expect(active).toContainText('Reading receipt with AI')

    server.progress(2001, { stage: 'reading', method: 'ai', items: 23 })
    await expect(active).toContainText('23 items found')

    server.progress(2001, { stage: 'rechecking', problems: 1, items: 23 })
    await expect(active).toContainText('Double-checking totals…')

    // Unknown stages are ignored.
    server.progress(2001, { stage: 'warp-drive' })
    await page.waitForTimeout(1500)
    await expect(active).toContainText('Double-checking totals…')

    server.progress(2001, { stage: 'categorizing' })
    await expect(active).toContainText('Categorizing & saving')

    server.finish(2001)
    await expect(approve(page)).toBeVisible()
  })

  test('single upload labels the OCR fallback', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    await startSingleUpload(page)

    server.progress(1001, { stage: 'reading', method: 'ocr' })
    await expect(page.getByTestId('processing-steps').locator('[aria-current="step"]'))
      .toContainText('Reading receipt (OCR)')
  })

  test('an upload can be left to finish in the background', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    // Once accepted, the receipt is in the list as "processing".
    await page.route('**/api/receipts', route => {
      if (route.request().method() !== 'GET') return route.fallback()
      return route.fulfill({
        json: server.enqueued.map(id => ({
          id, store_name: 'Unknown Store', receipt_date: null, scanned_at: '2026-02-21T10:00:00Z',
          status: 'processing', total: null, item_count: 0, total_verified: false,
        })),
      })
    })
    await startSingleUpload(page)

    await expect(page.getByText(/You can close this window/)).toBeVisible()
    await page.getByRole('button', { name: 'Continue in background' }).click()
    await expect(page.getByTestId('upload-status')).toHaveCount(0)

    await page.goto('/receipts')
    const row = page.getByRole('row').filter({ hasText: 'New receipt' })
    await expect(row).toBeVisible()
    await expect(row.getByText('Processing…').last()).toBeVisible()
  })

  test('a receipt that cannot be read shows why, and can be retried', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    await startSingleUpload(page)
    server.fail(1001, 'Could not read receipt')

    await expect(page.getByText('Could not read receipt')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('processing-steps')).toBeVisible()
    expect(server.reprocessed).toEqual([1001])

    server.finish(1001)
    await expect(approve(page)).toBeVisible()
  })

  test('discarding a failed receipt deletes it and returns to the picker', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    await startSingleUpload(page)
    server.fail(1001, 'Could not read receipt')

    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByRole('button', { name: /Process 1 receipt/ })).toBeVisible()
    expect(server.deleted).toEqual([1001])
  })

  test('a batch with a failure waits for the user instead of dropping it silently', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    await pickFiles(page, ['a.png', 'b.png'])
    await page.getByRole('button', { name: /Apply Crop/ }).click()
    await page.getByRole('button', { name: /Apply Crop/ }).click()
    await expect(page.getByTestId('upload-row')).toHaveCount(2)

    server.finish(1001)
    server.fail(1002, 'Failed to process PDF: bad xref')

    await expect(page.getByText('1 of 2 receipts ready')).toBeVisible()
    await expect(page.getByText('Failed to process PDF: bad xref')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry b.png' })).toBeVisible()

    // The good one can still be reviewed.
    await page.getByRole('button', { name: 'Review 1 receipt' }).click()
    await expect(approve(page)).toBeVisible()
    await expect(page.getByText(/\d+ of \d+/)).toHaveCount(0)
  })

  test('an upload that never reaches the server can be retried', async ({ page }) => {
    const server = await mockServer(page)
    let attempts = 0
    await page.route('**/api/receipts/enqueue', route => {
      attempts++
      if (attempts === 1) return route.fulfill({ status: 413, json: { detail: 'File too large (max 20 MB)' } })
      return route.fallback()
    })
    await startSingleUpload(page)

    await expect(page.getByText('Upload failed: File too large (max 20 MB)')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(approve(page)).toBeVisible()
    expect(server.enqueued).toEqual([1001])
  })

  test('cancelling the crop walkthrough keeps what was already uploaded', async ({ page }) => {
    const server = await mockServer(page, { autoFinish: false })
    await pickFiles(page, ['a.png', 'b.png', 'c.png'])
    await page.getByRole('button', { name: /Apply Crop/ }).click()
    await expect.poll(() => server.enqueued.length).toBe(1)

    await page.getByRole('button').filter({ has: page.locator('svg.lucide-x') }).click()

    // The one that was sent carries on; the rest are reported, not silently lost.
    await expect(page.getByTestId('processing-steps')).toBeVisible()
    await expect(page.getByText('2 photos were not uploaded because cropping was cancelled.')).toBeVisible()
    server.finish(1001)
    await expect(approve(page)).toBeVisible()
  })
})
