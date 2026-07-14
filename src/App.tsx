import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import type { AppShellRef } from './components/layout/AppShell'
import { Dashboard } from './pages/Dashboard'
import { AllReceipts } from './pages/AllReceipts'
import { ReviewReceipt } from './pages/ReviewReceipt'
import { Trends } from './pages/Trends'
import { Categories } from './pages/Categories'
import { LearnedItems } from './pages/LearnedItems'
import { Settings } from './pages/Settings'
import { UploadModal } from './components/UploadModal'
import { DuplicateWarningModal } from './components/DuplicateWarningModal'
import { useReceipt } from './hooks/useReceipts'
import { useCategoryList } from './hooks/useCategories'
import { useSaveReceipt, useDeleteReceipt } from './hooks/useReceipts'
import type { Page } from './types'
import type { ProcessingResult } from './api/receipts'
import { checkDuplicates, deleteReceipt as deleteReceiptApi } from './api/receipts'
import type { Receipt, SaveReceiptBody, DuplicateMatch } from './types'
import { advanceBatch, batchPosition } from './lib/batch'
import { ArrowLeft, Save, Camera, CheckCircle, MoreVertical, RotateCcw, Trash2, Pencil, SkipForward } from 'lucide-react'
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
    '/categories': 'categories', '/learned': 'learned', '/settings': 'settings',
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
      settings: '/settings',
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
  settings:   'Settings',
}

// ── Duplicate warning state ───────────────────────────────────────────────────

interface DupeWarning {
  duplicates: DuplicateMatch[]
  continueLabel: string
  resolve: (proceed: boolean) => void
}

// ── ReviewReceipt loader — handles both fresh upload and reopened receipt ─────

interface ReviewLoaderProps {
  receiptId: number
  freshResult: ProcessingResult | null
  onSaved: () => void
  onClose: () => void
  onRescan: () => void
  onDupeWarning: (dupes: DuplicateMatch[], continueLabel: string) => Promise<boolean>
}

function ReviewLoader({ receiptId, freshResult, onSaved, onClose, onRescan, onDupeWarning }: ReviewLoaderProps) {
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

  const categorizationFailed = freshResult?.categorization_failed ?? false

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
            const proceed = await onDupeWarning(dupes, 'Save Anyway')
            if (!proceed) return
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
      categorizationFailed={categorizationFailed}
      categories={categories}
      onSave={handleSave}
      onRescan={onRescan}
      onDelete={handleDelete}
    />
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  // Initialise state from the current URL so direct links and refreshes work
  const [route, setRoute]             = useState<RouteState>(() => parseUrl(window.location.pathname))
  // A "batch" is the queue of freshly-uploaded receipts being reviewed. A
  // single upload is just a batch of one. `freshResult` is the current one.
  const [batch, setBatch]             = useState<ProcessingResult[]>([])
  const [batchIndex, setBatchIndex]   = useState(0)
  const [uploadOpen, setUploadOpen]   = useState(false)
  const [dupeWarning, setDupeWarning] = useState<DupeWarning | null>(null)
  const shellRef = useRef<AppShellRef>(null)

  const freshResult = batch[batchIndex] ?? null
  const clearBatch = useCallback(() => { setBatch([]); setBatchIndex(0) }, [])

  const { page, receiptId } = route

  /** Show the duplicate warning modal and return whether the user chose to proceed. */
  const showDupeWarning = useCallback((dupes: DuplicateMatch[], continueLabel: string): Promise<boolean> => {
    return new Promise(resolve => {
      setDupeWarning({ duplicates: dupes, continueLabel, resolve })
    })
  }, [])

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
      clearBatch()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [page, receiptId, clearBatch])

  // Stamp state onto the initial history entry so popstate fires on first back
  useEffect(() => {
    window.history.replaceState({ page, receiptId }, '', window.location.pathname)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function openReceipt(id: number) { clearBatch(); navigate('review', id) }

  async function handleBatchSuccess(results: ProcessingResult[]) {
    setUploadOpen(false)
    shellRef.current?.closeSidebar()   // close mobile sidebar so review is visible
    if (results.length === 0) return

    // For a single upload, run the eager duplicate check (and allow discarding
    // the just-created receipt). For a batch we defer to per-receipt review —
    // each is a `pending` row the user can delete during the review queue.
    if (results.length === 1) {
      const result = results[0]
      if (result.total != null && result.receipt_date) {
        try {
          const dupes = await checkDuplicates(result.total, result.receipt_date, result.receipt_id)
          if (dupes.length > 0) {
            const proceed = await showDupeWarning(dupes, 'Review Anyway')
            if (!proceed) {
              try { await deleteReceiptApi(result.receipt_id) } catch { /* ignore */ }
              return
            }
          }
        } catch {
          // If the check fails, proceed normally
        }
      }
    }

    setBatch(results)
    setBatchIndex(0)
    navigate('review', results[0].receipt_id)
  }

  /** Advance the review queue after Approve or Skip; return to the list when done. */
  const handleAdvance = useCallback(() => {
    const { index, done } = advanceBatch(batch.length, batchIndex)
    if (done) {
      clearBatch()
      navigate('receipts', null, { skipGuard: true })
    } else {
      setBatchIndex(index)
      navigate('review', batch[index].receipt_id, { skipGuard: true })
    }
  }, [batch, batchIndex, navigate, clearBatch])

  // Skip (from the topbar during a batch) advances without saving.
  useEffect(() => {
    const handler = () => handleAdvance()
    window.addEventListener('tabulate:skip-receipt', handler)
    return () => window.removeEventListener('tabulate:skip-receipt', handler)
  }, [handleAdvance])

  function handleRescan() { clearBatch(); navigate('receipts'); setUploadOpen(true) }

  const batchInfo = batchPosition(batch.length, batchIndex)
  const isReview    = page === 'review'
  const reviewTitle = isReview
    ? (freshResult?.store_name ?? 'Receipt')
      + (freshResult?.receipt_date ? ` · ${freshResult.receipt_date}` : '')
      + (batchInfo ? ` · ${batchInfo.current} of ${batchInfo.total}` : '')
    : PAGE_TITLES[page]

  return (
    <>
      <AppShell
        ref={shellRef}
        currentPage={page}
        onNavigate={p => { clearBatch(); navigate(p) }}
        onUpload={() => setUploadOpen(true)}
        topbarTitle={reviewTitle}
        embedded={!!INGRESS_PREFIX}
        topbarLeft={isReview ? (
          <button
            onClick={() => navigate('receipts')}
            className="flex items-center justify-center w-9 h-9 sm:w-auto sm:h-auto sm:gap-1.5 sm:px-2 sm:py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors mr-1 sm:mr-2"
          >
            <ArrowLeft className="w-5 h-5 sm:w-4 sm:h-4" />
            <span className="hidden sm:inline">All Receipts</span>
          </button>
        ) : undefined}
        topbarRight={isReview ? (
          <TopbarReceiptActions
            receiptId={receiptId}
            isFreshUpload={freshResult != null}
            batchInfo={batchInfo}
          />
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
              onSaved={handleAdvance}
              onClose={() => navigate('receipts')}
              onRescan={handleRescan}
              onDupeWarning={showDupeWarning}
            />
          )}

          {page === 'trends'     && <Trends />}
          {page === 'categories' && <Categories />}
          {page === 'learned'    && <LearnedItems />}
          {page === 'settings'   && <Settings />}

        </div>
      </AppShell>

      {uploadOpen && (
        <UploadModal onClose={() => setUploadOpen(false)} onBatchSuccess={handleBatchSuccess} />
      )}

      {dupeWarning && (
        <DuplicateWarningModal
          duplicates={dupeWarning.duplicates}
          continueLabel={dupeWarning.continueLabel}
          onContinue={() => { dupeWarning.resolve(true); setDupeWarning(null) }}
          onCancel={() => { dupeWarning.resolve(false); setDupeWarning(null) }}
        />
      )}
    </>
  )
}

// ── Topbar receipt actions ────────────────────────────────────────────────────
function TopbarReceiptActions({ receiptId, isFreshUpload, batchInfo }: {
  receiptId: number | null
  isFreshUpload: boolean
  batchInfo: { current: number; total: number } | null
}) {
  const [visible, setVisible]   = useState(false)
  const [dirty, setDirty]       = useState(false)
  const [verified, setVerified] = useState(false)
  const [locked, setLocked]     = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const poll = () => {
      const w = window as any
      setVisible(!!w.__tabulate_isEditable)
      setDirty(!!w.__tabulate_isDirty)
      setVerified(!!w.__tabulate_isVerified)
      setLocked(!!w.__tabulate_isLocked)
    }
    poll()
    const id = setInterval(poll, 200)
    return () => clearInterval(id)
  }, [receiptId])

  // Close overflow menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  if (!receiptId) return null

  // Locked (verified, not editing): show Edit button only
  if (locked) {
    return (
      <div className="flex items-center gap-2">
        <button
          className="hidden sm:flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border transition-colors text-gray-700 bg-white border-gray-200 hover:bg-gray-50"
          onClick={() => window.dispatchEvent(new CustomEvent('tabulate:edit-receipt'))}
        >
          <Pencil className="w-4 h-4" />
          Edit
        </button>
        <button
          className="sm:hidden flex items-center justify-center w-9 h-9 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
          onClick={() => window.dispatchEvent(new CustomEvent('tabulate:edit-receipt'))}
        >
          <Pencil className="w-5 h-5" />
        </button>
      </div>
    )
  }

  if (!visible) return null

  return (
    <div className="flex items-center gap-2">
      {/* ── Desktop: Save + Approve with labels ── */}
      <button
        disabled={!dirty}
        className="hidden sm:flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border transition-colors text-gray-700 bg-white border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => window.dispatchEvent(new CustomEvent('tabulate:save-receipt'))}
      >
        <Save className="w-4 h-4" />
        Save
      </button>
      {batchInfo && (
        <button
          className="hidden sm:flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg border transition-colors text-gray-700 bg-white border-gray-200 hover:bg-gray-50"
          onClick={() => window.dispatchEvent(new CustomEvent('tabulate:skip-receipt'))}
          title="Skip to next receipt (leaves it pending)"
        >
          <SkipForward className="w-4 h-4" />
          Skip
        </button>
      )}
      {!verified && (
        <button
          className="hidden sm:flex items-center gap-1.5 h-9 px-3 text-xs font-semibold rounded-lg transition-colors text-white bg-green-600 hover:bg-green-700 shadow-sm shadow-green-600/30"
          onClick={() => window.dispatchEvent(new CustomEvent('tabulate:approve-receipt'))}
        >
          <CheckCircle className="w-4 h-4" />
          {batchInfo ? 'Approve & Next' : 'Approve'}
        </button>
      )}

      {/* ── Mobile: overflow menu + approve icon ── */}
      <div ref={menuRef} className="relative sm:hidden">
        <button
          onClick={() => setMenuOpen(o => !o)}
          className="flex items-center justify-center w-9 h-9 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
        >
          <MoreVertical className="w-5 h-5" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-40 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
            {isFreshUpload && (
              <button
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('tabulate:rescan-receipt')) }}
              >
                <RotateCcw className="w-4 h-4" />
                Rescan
              </button>
            )}
            <button
              disabled={!dirty}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('tabulate:save-receipt')) }}
            >
              <Save className="w-4 h-4" />
              Save
            </button>
            {batchInfo && (
              <button
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('tabulate:skip-receipt')) }}
              >
                <SkipForward className="w-4 h-4" />
                Skip to next
              </button>
            )}
            <button
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-red-500 hover:bg-red-50"
              onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('tabulate:delete-receipt')) }}
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        )}
      </div>
      {!verified && (
        <button
          className="sm:hidden flex items-center justify-center w-9 h-9 rounded-lg text-white bg-green-600 hover:bg-green-700 shadow-sm shadow-green-600/30 transition-colors"
          onClick={() => window.dispatchEvent(new CustomEvent('tabulate:approve-receipt'))}
        >
          <CheckCircle className="w-5 h-5" />
        </button>
      )}
    </div>
  )
}
