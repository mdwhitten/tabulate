import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { Receipt, SaveReceiptBody } from './types'
import { ArrowLeft, Save, Camera } from 'lucide-react'
import './index.css'

// ── URL ↔ Page/receiptId ──────────────────────────────────────────────────────

type RouteState = { page: Page; receiptId: number | null }

function parseUrl(path: string): RouteState {
  const reviewMatch = path.match(/^\/receipts\/(\d+)$/)
  if (reviewMatch) return { page: 'review', receiptId: Number(reviewMatch[1]) }
  const map: Record<string, Page> = {
    '/': 'dashboard', '/receipts': 'receipts', '/trends': 'trends',
    '/categories': 'categories', '/learned': 'learned',
  }
  return { page: map[path] ?? 'dashboard', receiptId: null }
}

function pageToPath(page: Page, receiptId?: number | null): string {
  if (page === 'review' && receiptId != null) return `/receipts/${receiptId}`
  const map: Record<Page, string> = {
    dashboard: '/', receipts: '/receipts', trends: '/trends',
    categories: '/categories', learned: '/learned', review: '/receipts',
  }
  return map[page]
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

  // Build a Receipt-compatible object from ProcessingResult if fresh
  const receipt: Receipt = freshResult
    ? {
        id: freshResult.receipt_id,
        store_name: freshResult.store_name,
        receipt_date: freshResult.receipt_date,
        scanned_at: new Date().toISOString(),
        status: 'pending',
        total: freshResult.total,
        tax: freshResult.tax,
        total_verified: freshResult.total_verified,
        verification_message: freshResult.verification_message,
        ocr_raw: freshResult.ocr_raw,
        image_path: null,
        thumbnail_path: freshResult.thumbnail_path,
        items: freshResult.items,
      }
    : fetchedReceipt!

  async function handleSave(body: SaveReceiptBody) {
    await save.mutateAsync(body)
    onSaved()
  }

  async function handleDelete() {
    if (!confirm('Delete this receipt?')) return
    await del.mutateAsync(receiptId)
    onClose()
  }

  return (
    <ReviewReceipt
      receipt={receipt}
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

  // Push a new history entry and update state
  const navigate = useCallback((newPage: Page, newReceiptId?: number | null) => {
    const newId = newReceiptId ?? null
    window.history.pushState({ page: newPage, receiptId: newId }, '', pageToPath(newPage, newId))
    setRoute({ page: newPage, receiptId: newId })
  }, [])

  // Browser back / forward
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      setRoute(e.state?.page
        ? { page: e.state.page, receiptId: e.state.receiptId ?? null }
        : parseUrl(window.location.pathname))
      setFreshResult(null)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Stamp state onto the initial history entry so popstate fires on first back
  useEffect(() => {
    window.history.replaceState({ page, receiptId }, '', window.location.pathname)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function openReceipt(id: number) { setFreshResult(null); navigate('review', id) }

  function handleUploadSuccess(result: ProcessingResult) {
    setUploadOpen(false)
    shellRef.current?.closeSidebar()   // close mobile sidebar so review is visible
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
          <SaveButtonSlot receiptId={receiptId} freshResult={freshResult} />
        ) : (
          <button
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#03a9f4] text-white text-xs font-semibold rounded-lg hover:bg-[#0290d1] transition-colors shadow-sm shadow-[#03a9f4]/30"
          >
            <Camera className="w-3.5 h-3.5" />
            Scan Receipt
          </button>
        )}
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
              onSaved={() => navigate('receipts')}
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

// ── Topbar Save button ────────────────────────────────────────────────────────
function SaveButtonSlot({
  receiptId,
  freshResult,
}: {
  receiptId: number | null
  freshResult: ProcessingResult | null
}) {
  // This is just a visual placeholder; actual save is triggered inside ReviewReceipt
  // We expose a global trigger via a CustomEvent for simplicity
  if (!receiptId) return null
  if (!freshResult) return null   // only show topbar Save for fresh uploads

  return (
    <button
      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#03a9f4] text-white text-xs font-semibold rounded-lg hover:bg-[#0290d1] transition-colors shadow-sm shadow-[#03a9f4]/30"
      onClick={() => window.dispatchEvent(new CustomEvent('pantry:save-receipt'))}
    >
      <Save className="w-3.5 h-3.5" />
      Save
    </button>
  )
}
