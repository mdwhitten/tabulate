/**
 * Lazy loader for the vendored OpenCV.js + jscanify browser scripts.
 *
 * Both files live in `public/vendor` and are served same-origin (opencv.js is
 * ~9MB). We inject them on first use only, so the heavy OpenCV payload never
 * affects initial app load. Loading is idempotent and the promise is cached;
 * a failed load clears the cache so the next call can retry.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    cv?: any
    jscanify?: any
  }
}

/** Absolute, ingress-aware base for static assets served from the app root. */
function assetBase(): string {
  const m = window.location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)/)
  return m ? m[1] : ''
}

function injectScript(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-vendor="${path}"]`)
    if (existing) {
      if (existing.dataset.loaded === 'true') { resolve(); return }
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${path}`)))
      return
    }
    const el = document.createElement('script')
    el.src = `${assetBase()}/${path}`
    el.async = true
    el.dataset.vendor = path
    el.addEventListener('load', () => { el.dataset.loaded = 'true'; resolve() })
    el.addEventListener('error', () => reject(new Error(`Failed to load ${path}`)))
    document.head.appendChild(el)
  })
}

/**
 * Resolve once the OpenCV runtime is initialised. `window.cv` is assigned as
 * soon as the script runs, but `cv.Mat` only becomes callable after the WASM
 * runtime finishes initialising — so we poll for it.
 */
function whenOpenCvReady(timeoutMs = 30_000): Promise<void> {
  const ready = () => typeof window.cv?.Mat === 'function'
  if (ready()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const iv = setInterval(() => {
      if (ready()) { clearInterval(iv); resolve() }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(iv); reject(new Error('OpenCV runtime init timed out'))
      }
    }, 100)
  })
}

let loadPromise: Promise<void> | null = null

/**
 * Load OpenCV.js + jscanify (once). Rejects if the scripts can't be fetched or
 * the runtime never initialises — callers should catch and fall back.
 */
export function loadScanner(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      await injectScript('vendor/opencv.js')
      await injectScript('vendor/jscanify.js')
      await whenOpenCvReady()
    })().catch(err => {
      loadPromise = null   // allow retry on next call
      throw err
    })
  }
  return loadPromise
}

/** True once both globals are present and the OpenCV runtime is ready. */
export function scannerReady(): boolean {
  return typeof window.cv?.Mat === 'function' && typeof window.jscanify === 'function'
}
