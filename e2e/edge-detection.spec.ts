/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test'
import { mockAllApis } from './fixtures'

/**
 * Runs the real client-side receipt detector (vendored OpenCV.js) against
 * receipts painted onto a canvas, and checks the detected corners against the
 * known truth. The upload specs block OpenCV for speed; this one covers it.
 */

type P = [number, number]
interface Scene {
  w: number
  h: number
  /** Receipt corners TL, TR, BR, BL in px. */
  quad: [P, P, P, P]
  background: string
  paper: string
  /** Paint a speckled (granite-like) worktop over the background colour. */
  speckle?: boolean
}

/** Paint the scene in the page and return detectCorners() as px coordinates. */
async function detect(page: Page, scene: Scene): Promise<P[] | null> {
  return page.evaluate(async (s) => {
    const opencv = '/src/lib/opencv.ts'
    const scanner = '/src/lib/scanner.ts'
    const { loadScanner } = await import(/* @vite-ignore */ opencv)
    const { detectCorners } = await import(/* @vite-ignore */ scanner)
    await loadScanner()

    const canvas = document.createElement('canvas')
    canvas.width = s.w
    canvas.height = s.h
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = s.background
    ctx.fillRect(0, 0, s.w, s.h)
    if (s.speckle) {
      let seed = 7
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      for (let i = 0; i < 9000; i++) {
        const v = Math.round(40 + rand() * 150)
        ctx.fillStyle = `rgb(${v},${v},${v})`
        ctx.fillRect(rand() * s.w, rand() * s.h, 3 + rand() * 5, 3 + rand() * 5)
      }
    }

    // Paper, with rows of "print" laid out in the receipt's own coordinates.
    const [tl, tr, br, bl] = s.quad
    const at = (u: number, v: number): [number, number] => [
      (1 - v) * ((1 - u) * tl[0] + u * tr[0]) + v * ((1 - u) * bl[0] + u * br[0]),
      (1 - v) * ((1 - u) * tl[1] + u * tr[1]) + v * ((1 - u) * bl[1] + u * br[1]),
    ]
    ctx.fillStyle = s.paper
    ctx.beginPath()
    ctx.moveTo(...tl); ctx.lineTo(...tr); ctx.lineTo(...br); ctx.lineTo(...bl)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = '#222'
    ctx.lineWidth = 3
    for (let v = 0.08; v < 0.93; v += 0.035) {
      ctx.beginPath()
      ctx.moveTo(...at(0.1, v)); ctx.lineTo(...at(v % 0.07 < 0.035 ? 0.9 : 0.6, v))
      ctx.stroke()
    }

    const corners = detectCorners(canvas) as [number, number][] | null
    return corners ? corners.map(([x, y]) => [x * s.w, y * s.h] as [number, number]) : null
  }, scene)
}

function expectClose(found: P[] | null, truth: P[], tolerancePx: number) {
  expect(found).not.toBeNull()
  found!.forEach(([x, y], i) => {
    expect(Math.hypot(x - truth[i][0], y - truth[i][1]), `corner ${i}`).toBeLessThanOrEqual(tolerancePx)
  })
}

test.describe('Receipt edge detection', () => {
  test.setTimeout(60_000)   // first run loads ~9MB of OpenCV

  test.beforeEach(async ({ page }, testInfo) => {
    // One browser project is enough for an image-processing check.
    test.skip(testInfo.project.name !== 'chromium', 'chromium only')
    await mockAllApis(page)
    await page.goto('/')
  })

  test('finds a rotated, perspective-skewed receipt on a wooden table', async ({ page }) => {
    const quad: Scene['quad'] = [[420, 260], [980, 330], [900, 1650], [330, 1560]]
    const found = await detect(page, { w: 1500, h: 2000, quad, background: '#6b4a2b', paper: '#f1efe9' })
    expectClose(found, quad, 20)
  })

  test('finds a receipt on a speckled worktop despite the print and texture', async ({ page }) => {
    const quad: Scene['quad'] = [[500, 300], [1050, 280], [1080, 1500], [520, 1530]]
    const found = await detect(page, {
      w: 1500, h: 2000, quad, background: '#6e6e6e', paper: '#f4f4f0', speckle: true,
    })
    expectClose(found, quad, 25)
  })

  test('finds a small receipt shot from a distance', async ({ page }) => {
    const quad: Scene['quad'] = [[600, 800], [900, 810], [890, 1300], [590, 1290]]
    const found = await detect(page, { w: 1500, h: 2000, quad, background: '#2a2f3a', paper: '#eeeeee' })
    expectClose(found, quad, 20)
  })

  test('handles a long receipt that runs off the top and bottom of the frame', async ({ page }) => {
    const quad: Scene['quad'] = [[480, -200], [1000, -200], [1040, 2200], [520, 2200]]
    const found = await detect(page, { w: 1500, h: 2000, quad, background: '#4a3a2a', paper: '#f0f0ec' })
    // Corners are clamped to the frame: left/right edges where they cross it.
    expectClose(found, [[483, 0], [1003, 0], [1037, 2000], [517, 2000]], 25)
  })

  test('does not invent a crop when there is no receipt', async ({ page }) => {
    const found = await page.evaluate(async () => {
      const opencv = '/src/lib/opencv.ts'
      const scanner = '/src/lib/scanner.ts'
      const { loadScanner } = await import(/* @vite-ignore */ opencv)
      const { detectCorners } = await import(/* @vite-ignore */ scanner)
      await loadScanner()
      const canvas = document.createElement('canvas')
      canvas.width = 900
      canvas.height = 1200
      const ctx = canvas.getContext('2d')!
      const g = ctx.createLinearGradient(0, 0, 900, 1200)
      g.addColorStop(0, '#8a6a4a')
      g.addColorStop(1, '#5a4030')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 900, 1200)
      return detectCorners(canvas)
    })
    expect(found).toBeNull()
  })
})
