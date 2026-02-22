import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import type { AppShellRef } from './components/layout/AppShell'
import { Dashboard } from './pages/Dashboard'
import { AllReceipts } from './pages/AllReceipts'
import { ReviewReceipt } from './pages/ReviewReceipt'
import { Trends } from './pages/Trends'
import { Categories } from './pages/Categories'
import { LearnedItems } from './pages/LearnedItems'
import { UploadModal } from './components/UploadModal'
import { useReceipt } from './hooks/useReceipts'
import { useCategoryList } from './hooks/useCategories'
import { useSaveReceipt, useDeleteReceipt } from './hooks/useReceipts'
import type { Page } from './types'
import type { ProcessingResult } from './api/receipts'
import { checkDuplicates, deleteReceipt as deleteReceiptApi } from './api/receipts'
import type { Receipt, SaveReceiptBody } from './types'
import { ArrowLeft, Save, Camera, CheckCircle } from 'lucide-react'
import './index.css'

// ── Ingress-aware URL helpers ─────────────────────────────────────────────────

/**
 * Detect the HA ingress prefix from the current URL so that pushState and
 * parseUrl work correctly whether running standalone or inside HA ingress.
 *
 * HA ingress serves the app at /api/hassio_ingress/<token>/
 * Standalone serves at /
 */
const INGRESS_PREFIX = (() => {
  const m = window.location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)/)
  return m ? m[1] : ''
})()

type RouteState = { page: Page; receiptId: number | null }

/** Strip the ingress prefix (if any) before matching routes. */
function parseUrl(fullPath: string): RouteState {
  const path = INGRESS_PREFIX
    ? fullPath.replace(INGRESS_PREFIX, '') || '/'
    : fullPath
  const reviewMatch = path.match(/^\/receipts\/(\d+)$/)
  if (reviewMatch) return { page: 'review', receiptId: Number(reviewMatch[1]) }
  const map: Record<string, Page> = {
    '/': 'dashboard', '/receipts': 'receipts', '/trends': 'trends',
    '/categories': 'categories', '/learned': 'learned',
  }
  return { page: map[path] ?? 'dashboard', receiptId: null }
}

/** Build a full browser path including ingress prefix. */
function pageToPath(page: Page, receiptId?: number | null): string {
  let rel = '/'
  if (page === 'review' && receiptId != null) {
    rel = `/receipts/${receiptId}`
  } else {
    const map: Record<Page, string> = {
      dashboard: '/', receipts: '/receipts', trends: '/trends',
      categories: '/categories', learned: '/learned', review: '/receipts',
    }
    rel = map[page]
  }
  return INGRESS_PREFIX + rel
}

const PAGE_TITLES: Record<Page, string> = {
  dashboard:  'Dashboard',
  receipts:   'All Receipts',
  trends:     'Trends',
  categories: 'Categories',
  learned:    'Learned Items',
  review:     'Review Receipt',
}

// ── ReviewReceipt loader — handles both fresh upload and reopened receipt ─────

interface ReviewLoaderProps {
  receiptId: number
  freshResult: ProcessingResult | null
  onSaved: () => void
  onClose: () => void
  onRescan: () => void
}

function ReviewLoader({ receiptId, freshResult, onSaved, onClose, onRescan }: ReviewLoaderProps) {
  const { data: fetchedReceipt, isLoading, isError } = useReceipt(
    freshResult ? null : receiptId  // skip fetch when we have fresh data
  )
  const { data: categories = [] } = useCategoryList()
  const save   = useSaveReceipt(receiptId)
  const del    = useDeleteReceipt()

  // Build a Receipt-compatible object from ProcessingResult if fresh
  // Memoize so the reference is stable (prevents unnecessary resets in ReviewReceipt)
  // Must be before early returns to satisfy Rules of Hooks
  const receipt: Receipt | null = useMemo(() => {
    if (freshResult) {
      return {
        id: freshResult.receipt_id,
        store_name: freshResult.store_name,
        receipt_date: freshResult.receipt_date,
        scanned_at: new Date().toISOString(),
        status: 'pending' as const,
        total: freshResult.total,
        tax: freshResult.tax,
        total_verified: freshResult.total_verified,
        verification_message: freshResult.verification_message,
        ocr_raw: freshResult.ocr_raw,
        image_path: null,
        thumbnail_path: freshResult.thumbnail_path,
        items: freshResult.items,
      }
    }
    return fetchedReceipt ?? null
  }, [freshResult, fetchedReceipt])

  if (!freshResult && isLoading) {
    return (
      <div className="flex items-center justify-center py-32 text-gray-400 text-sm">
        Loading receipt…
      </div>
    )
  }

  if (!freshResult && isError) {
    return (
      <div className="flex items-center justify-center py-32 text-red-400 text-sm">
        Failed to load receipt.
      </div>
    )
  }

  async function handleSave(body: SaveReceiptBody) {
    // If the upload was missing total or date, the user filled them in during
    // review — check for duplicates now (upload-time check was skipped).
    const uploadHadBoth = freshResult != null
      && freshResult.total != null
      && freshResult.receipt_date != null
    if (!uploadHadBoth) {
      const total = body.manual_total ?? receipt?.total ?? null
      const date = body.receipt_date ?? receipt?.receipt_date ?? null
      if (total != null && date) {
        try {
          const dupes = await checkDuplicates(total, date, receiptId)
          if (dupes.length > 0) {
            const dupeList = dupes
              .map(d => `  - ${d.store_name} on ${d.receipt_date} ($${d.total?.toFixed(2)}) [${d.status}]`)
              .join('\n')
            const ok = window.confirm(
              `Possible duplicate receipt found:\n\n${dupeList}\n\nAnother receipt with the same total and date already exists. Save anyway?`
            )
            if (!ok) return
          }
        } catch {
          // If the check fails, don't block the save
        }
      }
    }

    await save.mutateAsync(body)
    if (body.approve) {
      onSaved()
    }
    // Draft save: stay on page — React Query invalidation refreshes data
  }

  async function handleDelete() {
    if (!confirm('Delete this receipt?')) return
    await del.mutateAsync(receiptId)
    onClose()
  }

  return (
    <ReviewReceipt
      receipt={receipt!}
      isFreshUpload={freshResult != null}
      categories={categories}
      onSave={handleSave}
      onClose={onClose}
      onRescan={onRescan}
      onDelete={handleDelete}
    />
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  // Initialise state from the current URL so direct links and refreshes work
  const [route, setRoute]             = useState<RouteState>(() => parseUrl(window.location.pathname))
  const [freshResult, setFreshResult] = useState<ProcessingResult | null>(null)
  const [uploadOpen, setUploadOpen]   = useState(false)
  const shellRef = useRef<AppShellRef>(null)

  const { page, receiptId } = route

  /** Check whether ReviewReceipt has unsaved changes; prompt if so. */
  const confirmIfDirty = useCallback((): boolean => {
    if ((window as any).__tabulate_isDirty) {
      return window.confirm('You have unsaved changes. Leave without saving?')
    }
    return true
  }, [])

  // Push a new history entry and update state
  const navigate = useCallback((newPage: Page, newReceiptId?: number | null, { skipGuard = false } = {}) => {
    if (!skipGuard && !confirmIfDirty()) return
    const newId = newReceiptId ?? null
    window.history.pushState({ page: newPage, receiptId: newId }, '', pageToPath(newPage, newId))
    setRoute({ page: newPage, receiptId: newId })
  }, [confirmIfDirty])

  // Browser back / forward
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      if ((window as any).__tabulate_isDirty) {
        if (!window.confirm('You have unsaved changes. Leave without saving?')) {
          // Re-push the current route to undo the back/forward
          window.history.pushState(
            { page, receiptId },
            '',
            pageToPath(page, receiptId)
          )
          return
        }
      }
      setRoute(e.state?.page
        ? { page: e.state.page, receiptId: e.state.receiptId ?? null }
        : parseUrl(window.location.pathname))
      setFreshResult(null)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [page, receiptId])

  // Stamp state onto the initial history entry so popstate fires on first back
  useEffect(() => {
    window.history.replaceState({ page, receiptId }, '', window.location.pathname)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function openReceipt(id: number) { setFreshResult(null); navigate('review', id) }

  async function handleUploadSuccess(result: ProcessingResult) {
    setUploadOpen(false)
    shellRef.current?.closeSidebar()   // close mobile sidebar so review is visible

    // If OCR extracted both total and date, check for duplicates immediately
    if (result.total != null && result.receipt_date) {
      try {
        const dupes = await checkDuplicates(result.total, result.receipt_date, result.receipt_id)
        if (dupes.length > 0) {
          const dupeList = dupes
            .map(d => `  - ${d.store_name} on ${d.receipt_date} ($${d.total?.toFixed(2)}) [${d.status}]`)
            .join('\n')
          const ok = window.confirm(
            `Possible duplicate receipt found:\n\n${dupeList}\n\nAnother receipt with the same total and date already exists. Continue reviewing?`
          )
          if (!ok) {
            // Discard the newly created receipt
            try { await deleteReceiptApi(result.receipt_id) } catch { /* ignore */ }
            return
          }
        }
      } catch {
        // If the check fails, proceed normally
      }
    }

    setFreshResult(result)
    navigate('review', result.receipt_id)
  }

  function handleRescan() { setFreshResult(null); navigate('receipts'); setUploadOpen(true) }

  const isReview    = page === 'review'
  const reviewTitle = isReview
    ? (freshResult?.store_name ?? 'Receipt') + (freshResult?.receipt_date ? ` · ${freshResult.receipt_date}` : '')
    : PAGE_TITLES[page]

  return (
    <>
      <AppShell
        ref={shellRef}
        currentPage={page}
        onNavigate={p => { setFreshResult(null); navigate(p) }}
        onUpload={() => setUploadOpen(true)}
        topbarTitle={reviewTitle}
        embedded={!!INGRESS_PREFIX}
        topbarLeft={isReview ? (
          <button
            onClick={() => navigate('receipts')}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors mr-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">All Receipts</span>
          </button>
        ) : undefined}
        topbarRight={isReview ? (
          <TopbarReceiptActions receiptId={receiptId} />
        ) : !INGRESS_PREFIX ? (
          <button
            onClick={() => setUploadOpen(true)}
            title="Scan Receipt"
            aria-label="Scan Receipt"
            className="flex items-center gap-1.5 h-9 px-3 bg-[#03a9f4] text-white text-xs font-semibold rounded-lg hover:bg-[#0290d1] transition-colors shadow-sm shadow-[#03a9f4]/30"
          >
            <Camera className="w-4 h-4" />
            Scan
          </button>
        ) : undefined}
      >
        <div key={`${page}-${receiptId}`} className="animate-[fadeUp_200ms_ease-out]">

          {page === 'dashboard' && (
            <Dashboard onNavigate={p => navigate(p)} onOpenReceipt={openReceipt} />
          )}

          {page === 'receipts' && (
            <AllReceipts onOpenReceipt={openReceipt} />
          )}

          {page === 'review' && receiptId != null && (
            <ReviewLoader
              receiptId={receiptId}
              freshResult={freshResult}
              onSaved={() => navigate('receipts', null, { skipGuard: true })}
              onClose={() => navigate('receipts')}
              onRescan={handleRescan}
            />
          )}

          {page === 'trends'     && <Trends />}
          {page === 'categories' && <Categories />}
          {page === 'learned'    && <LearnedItems />}

        </div>
      </AppShell>

      {uploadOpen && (
        <UploadModal onClose={() => setUploadOpen(false)} onSuccess={handleUploadSuccess} />
      )}
    </>
  )
}

// ── Topbar receipt actions (Save + Approve) ──────────────────────────────────
function TopbarReceiptActions({ receiptId }: { receiptId: number | null }) {
  const [visible, setVisible]   = useState(false)
  const [dirty, setDirty]       = useState(false)
  const [verified, setVerified] = useState(false)

  useEffect(() => {
    const poll = () => {
      const w = window as any
      setVisible(!!w.__tabulate_isEditable)
      setDirty(!!w.__tabulate_isDirty)
      setVerified(!!w.__tabulate_isVerified)
    }
    poll()
    const id = setInterval(poll, 200)
    return () => clearInterval(id)
  }, [receiptId])

  if (!receiptId || !visible) return null

  return (
    <div className="flex items-center gap-2">
      <button
        disabled={!dirty}
        className="flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border transition-colors text-gray-700 bg-white border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => window.dispatchEvent(new CustomEvent('tabulate:save-receipt'))}
      >
        <Save className="w-4 h-4" />
        Save
      </button>
      {!verified && (
        <button
          className="flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg transition-colors text-white bg-green-600 hover:bg-green-700 shadow-sm shadow-green-600/30"
          onClick={() => window.dispatchEvent(new CustomEvent('tabulate:approve-receipt'))}
        >
          <CheckCircle className="w-4 h-4" />
          Approve
        </button>
      )}
    </div>
  )
}
