import { ArrowRight, Loader2 } from 'lucide-react'
import { StatCard } from '../components/StatCard'
import { CategoryBarChart } from '../components/charts/CategoryBarChart'
import { ReceiptRow } from '../components/ReceiptRow'
import { useReceiptList } from '../hooks/useReceipts'
import { useMonthlyTrends, useDashboardSummary } from '../hooks/useTrends'
import { useCategoryList } from '../hooks/useCategories'
import { fmt } from '../lib/utils'
import type { Page } from '../types'

interface DashboardProps {
  onNavigate: (p: Page) => void
  onOpenReceipt: (id: number) => void
}

export function Dashboard({ onNavigate, onOpenReceipt }: DashboardProps) {
  const receiptsQ   = useReceiptList()
  const trendsQ     = useMonthlyTrends(6)
  const summaryQ    = useDashboardSummary()
  const categoriesQ = useCategoryList()

  const isLoading = receiptsQ.isLoading || trendsQ.isLoading || summaryQ.isLoading

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32 text-gray-400 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading dashboard…</span>
      </div>
    )
  }

  const receipts = receiptsQ.data ?? []
  const trends   = trendsQ.data
  const summary  = summaryQ.data

  const latestMonth = trends?.months.at(-1) ?? null
  const prevMonth   = trends?.months.at(-2) ?? null

  const thisMonthTotal = summary?.month_total ?? 0
  const prevMonthTotal = prevMonth?.total ?? 0
  const monthDiff      = thisMonthTotal - prevMonthTotal
  const monthDiffPct   = prevMonthTotal > 0
    ? Math.round(Math.abs(monthDiff / prevMonthTotal) * 100)
    : 0

  const pendingCount = receipts.filter(r => r.status !== 'verified').length
  const avgTrip      = summary?.avg_trip ?? null

  // Top category this month
  const catEntries = latestMonth
    ? Object.entries(latestMonth.by_category).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a)
    : []
  const [topCat, topVal] = catEntries[0] ?? ['—', 0]

  const chartData = catEntries.map(([category, amount]) => ({ category, amount }))

  return (
    <div className="space-y-5 max-w-5xl">

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          eyebrow="This Month"
          value={fmt(thisMonthTotal)}
          sub={latestMonth?.month_label ?? '—'}
          trend={prevMonthTotal > 0 ? {
            label: `${monthDiff > 0 ? '+' : '-'}$${Math.abs(monthDiff).toFixed(0)} vs last month (${monthDiffPct}%)`,
            up: monthDiff > 0,
          } : undefined}
          accent
        />
        <StatCard
          eyebrow="Receipts"
          value={String(summary?.receipt_count ?? receipts.length)}
          sub={`${pendingCount} pending approval`}
          icon="🧾"
          onClick={() => onNavigate('receipts')}
          linkLabel="View all"
        />
        <StatCard
          eyebrow="Top Category"
          value={topVal > 0 ? fmt(topVal) : '—'}
          sub={topCat}
          icon="🏆"
        />
        <StatCard
          eyebrow="Avg Trip"
          value={avgTrip != null ? fmt(avgTrip) : '—'}
          sub="last 3 months"
          icon="🛒"
        />
      </div>

      {/* ── Main content row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">

        {/* Category breakdown chart */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-[11px] uppercase tracking-widest font-semibold text-gray-400 mb-0.5">
                Spending by Category
              </p>
              <p className="text-sm font-semibold text-gray-800">
                {latestMonth?.month_label ?? 'This Month'}
              </p>
            </div>
            <button
              onClick={() => onNavigate('trends')}
              className="flex items-center gap-1 text-xs text-[#03a9f4] hover:text-[#0290d1] font-medium transition-colors"
            >
              View trends <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          {chartData.length > 0 ? (
            <CategoryBarChart data={chartData} categories={categoriesQ.data} />
          ) : (
            <p className="text-sm text-gray-400 text-center py-8">No spending data yet.</p>
          )}
        </div>

        {/* Recent receipts */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] flex flex-col">
          <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
            <div>
              <p className="text-[11px] uppercase tracking-widest font-semibold text-gray-400 mb-0.5">
                Recent Receipts
              </p>
              <p className="text-sm font-semibold text-gray-800">Latest activity</p>
            </div>
            <button
              onClick={() => onNavigate('receipts')}
              className="flex items-center gap-1 text-xs text-[#03a9f4] hover:text-[#0290d1] font-medium transition-colors"
            >
              View all <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="flex-1 px-2 pb-3 divide-y divide-gray-50">
            {receipts.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No receipts yet.</p>
            ) : (
              receipts.slice(0, 5).map(r => (
                <ReceiptRow key={r.id} receipt={r} onClick={() => onOpenReceipt(r.id)} />
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
