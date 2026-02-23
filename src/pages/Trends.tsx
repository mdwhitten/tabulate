import { useState, useMemo, useRef } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useMonthlyTrends } from '../hooks/useTrends'
import { useCategoryList } from '../hooks/useCategories'
import { catColor, catIcon, fmt, fmtShort } from '../lib/utils'
import type { Category, TrendsResponse, MonthSummary } from '../types'

// ── Constants ──────────────────────────────────────────────────────────────

const BAR_WIDTH    = 50
const BAR_GAP      = 18
const COL_STRIDE   = BAR_WIDTH + BAR_GAP
const CHART_H      = 220
const PAD_L        = 52
const PAD_R        = 12
const PAD_T        = 12
const PAD_B        = 44
const GRID_LINES   = 4

// ── Helpers ────────────────────────────────────────────────────────────────

function niceMax(value: number): number {
  if (value <= 0) return 100
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)))
  const normalized = value / magnitude
  const steps = [1, 1.5, 2, 3, 4, 5, 6, 8, 10]
  const niceNorm = steps.find(s => s >= normalized) ?? 10
  return niceNorm * magnitude
}

function shortLabel(label: string): string {
  return label.split(' ')[0] ?? label
}

function fmtPct(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`
}

// ── Tooltip ────────────────────────────────────────────────────────────────

interface TooltipInfo {
  x: number     // viewport px
  y: number     // viewport px
  cat: string
  amount: number
  month: string
}

// ── Stacked bar SVG chart ──────────────────────────────────────────────────

interface BarChartProps {
  data:        TrendsResponse
  selectedIdx: number
  onSelect:    (idx: number) => void
  cats?:       Category[]
}

function StackedBarChart({ data, selectedIdx, onSelect, cats }: BarChartProps) {
  const { months, categories } = data
  const n = months.length

  const svgRef = useRef<SVGSVGElement>(null)
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null)

  const svgW = PAD_L + n * COL_STRIDE - BAR_GAP + PAD_R
  const svgH = CHART_H
  const barAreaH = svgH - PAD_T - PAD_B

  const dataMax  = Math.max(...months.map(m => m.total), 1)
  const yMax     = niceMax(dataMax * 1.05)
  const gridStep = yMax / (GRID_LINES - 1)

  const toY = (val: number) => PAD_T + barAreaH - (val / yMax) * barAreaH
  const yBaseline = toY(0)

  function handleSegmentEnter(
    e: React.MouseEvent | React.TouchEvent,
    cat: string,
    amount: number,
    month: string
  ) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    let clientX: number, clientY: number
    if ('touches' in e) {
      clientX = e.touches[0]?.clientX ?? 0
      clientY = e.touches[0]?.clientY ?? 0
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }
    setTooltip({
      x: clientX - rect.left,
      y: clientY - rect.top - 8,
      cat,
      amount,
      month,
    })
  }

  // Cap the rendered width so the chart doesn't blow up with few months.
  // Each column is ~68px in viewBox units; allow ~120px rendered per column with some padding.
  const maxPx = Math.max(280, n * 120 + 80)

  return (
    <div className="relative w-full" style={{ maxWidth: maxPx }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgW} ${svgH}`}
        width="100%"
        preserveAspectRatio="xMinYMid meet"
        className="overflow-visible"
        aria-label="Monthly spending stacked bar chart"
        onMouseLeave={() => setTooltip(null)}
      >
        {Array.from({ length: GRID_LINES }, (_, i) => {
          const val = gridStep * i
          const y   = toY(val)
          return (
            <g key={i}>
              <line x1={PAD_L - 6} y1={y} x2={svgW - PAD_R} y2={y}
                stroke="#e5e7eb" strokeWidth={1} strokeDasharray={i === 0 ? 'none' : '3 3'} />
              <text x={PAD_L - 10} y={y} textAnchor="end" dominantBaseline="middle"
                fontSize={10} fill="#9ca3af" fontFamily="ui-monospace, 'JetBrains Mono', monospace">
                {fmtShort(val)}
              </text>
            </g>
          )
        })}

        {months.map((month, colIdx) => {
          const x          = PAD_L + colIdx * COL_STRIDE
          const isSelected = colIdx === selectedIdx

          let stackY = yBaseline
          const segments: { cat: string; y: number; h: number }[] = []

          for (const cat of categories) {
            const val = month.by_category[cat] ?? 0
            if (val <= 0) continue
            const segH = (val / yMax) * barAreaH
            stackY    -= segH
            segments.push({ cat, y: stackY, h: segH })
          }

          const barTop = stackY
          const barH   = yBaseline - barTop
          const clipId = `bar-clip-${colIdx}`

          return (
            <g key={colIdx} onClick={() => onSelect(colIdx)} style={{ cursor: 'pointer' }}
              role="button" aria-label={`${month.month_label}: ${fmt(month.total)}`}
              aria-pressed={isSelected}>

              {isSelected && (
                <rect x={x - 8} y={PAD_T} width={BAR_WIDTH + 16} height={barAreaH}
                  fill="#03a9f4" opacity={0.06} rx={6} />
              )}

              {/* Invisible hit area for whole column */}
              <rect x={x - 8} y={PAD_T} width={BAR_WIDTH + 16} height={barAreaH + PAD_B} fill="transparent" />

              {/* Clip path rounds the entire bar as one unit */}
              {segments.length > 0 && (
                <defs>
                  <clipPath id={clipId}>
                    <rect x={x} y={barTop} width={BAR_WIDTH} height={barH} rx={4} />
                  </clipPath>
                </defs>
              )}

              <g clipPath={segments.length > 0 ? `url(#${clipId})` : undefined}>
                {segments.map(({ cat, y, h }) => (
                  <rect
                    key={cat}
                    x={x} y={y} width={BAR_WIDTH} height={Math.max(h, 1)}
                    fill={catColor(cat, cats)}
                    onMouseEnter={e => handleSegmentEnter(e, cat, month.by_category[cat] ?? 0, month.month_label)}
                    onTouchStart={e => { e.stopPropagation(); handleSegmentEnter(e, cat, month.by_category[cat] ?? 0, month.month_label) }}
                    style={{ cursor: 'pointer' }}
                  />
                ))}
              </g>

              <text x={x + BAR_WIDTH / 2} y={yBaseline + 14} textAnchor="middle" fontSize={11}
                fontWeight={isSelected ? 700 : 400} fill={isSelected ? '#03a9f4' : '#6b7280'}
                fontFamily="ui-sans-serif, system-ui, sans-serif">
                {shortLabel(month.month_label)}
              </text>

              <text x={x + BAR_WIDTH / 2} y={yBaseline + 28} textAnchor="middle" fontSize={10}
                fill={isSelected ? '#03a9f4' : '#9ca3af'}
                fontFamily="ui-monospace, 'JetBrains Mono', monospace"
                fontWeight={isSelected ? 600 : 400}>
                {fmtShort(month.total)}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 flex items-center gap-2 bg-gray-900/90 text-white text-xs px-3 py-2 rounded-xl shadow-lg backdrop-blur-sm whitespace-nowrap"
          style={{
            left: tooltip.x,
            top:  tooltip.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: catColor(tooltip.cat, cats) }} />
          <span>{catIcon(tooltip.cat, cats)} {tooltip.cat}</span>
          <span className="font-mono font-semibold">{fmt(tooltip.amount)}</span>
        </div>
      )}
    </div>
  )
}

// ── Month breakdown ────────────────────────────────────────────────────────

interface BreakdownEntry {
  category:  string
  amount:    number
  avgAmount: number
  sharePct:  number
  changePct: number | null
}

interface BreakdownProps {
  month:     MonthSummary
  prevMonth: MonthSummary | null
  allMonths: MonthSummary[]
  selIdx:    number
  cats?:     Category[]
}

function MonthBreakdown({ month, prevMonth, allMonths, selIdx, cats }: BreakdownProps) {
  const entries = useMemo<BreakdownEntry[]>(() => {
    const allCats = new Set([
      ...Object.keys(month.by_category),
      ...(prevMonth ? Object.keys(prevMonth.by_category) : []),
    ])

    // Compute average per category across all months
    const catAvg: Record<string, number> = {}
    for (const cat of allCats) {
      let sum = 0, count = 0
      for (const m of allMonths) {
        const val = m.by_category[cat] ?? 0
        if (val > 0) { sum += val; count++ }
      }
      catAvg[cat] = count > 0 ? sum / count : 0
    }

    const rows: BreakdownEntry[] = []
    for (const cat of allCats) {
      const amount     = month.by_category[cat] ?? 0
      const prevAmount = prevMonth ? (prevMonth.by_category[cat] ?? 0) : null
      if (amount <= 0 && (prevAmount == null || prevAmount <= 0)) continue
      const changePct  = prevAmount != null && prevAmount > 0
        ? ((amount - prevAmount) / prevAmount) * 100
        : null
      rows.push({ category: cat, amount, avgAmount: catAvg[cat] ?? 0, sharePct: 0, changePct })
    }

    rows.sort((a, b) => b.amount - a.amount)
    const maxAmt = rows.reduce((m, r) => Math.max(m, r.amount), 0)
    for (const r of rows) r.sharePct = maxAmt > 0 ? (r.amount / maxAmt) * 100 : 0
    return rows
  }, [month, prevMonth, allMonths])

  return (
    <div key={selIdx} className="space-y-1">
      {entries.length === 0 && (
        <p className="py-6 text-center text-sm text-gray-400">No spending data for this month.</p>
      )}
      {entries.map((entry, i) => {
        const isZero     = entry.amount === 0
        const changeDown = entry.changePct != null && entry.changePct < 0
        const changeUp   = entry.changePct != null && entry.changePct > 0
        const changeNone = entry.changePct == null || entry.changePct === 0

        return (
          <div key={entry.category}
            className="flex items-center gap-3 py-2 px-1 rounded-xl hover:bg-gray-50 transition-colors"
            style={{ opacity: 0, animation: `fadeUp 180ms ease-out ${i * 35}ms forwards` }}>

            <div className="flex items-center gap-2 w-36 shrink-0">
              <span className="text-base leading-none">{catIcon(entry.category, cats)}</span>
              <span className="text-sm text-gray-700 truncate">{entry.category}</span>
            </div>

            <div className="flex-1 min-w-0">
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                {!isZero && (
                  <div className="h-full rounded-full transition-[width] duration-500 ease-out"
                    style={{ width: `${entry.sharePct}%`, background: catColor(entry.category, cats) }} />
                )}
              </div>
            </div>

            <span className="text-sm font-mono tabular-nums text-gray-800 w-16 text-right shrink-0">
              {isZero ? '—' : fmt(entry.amount)}
            </span>

            <span className="text-sm font-mono tabular-nums text-gray-400 w-16 text-right shrink-0 hidden sm:inline">
              {entry.avgAmount > 0 ? fmt(entry.avgAmount) : '—'}
            </span>

            <span className={[
              'text-xs font-mono tabular-nums w-14 text-right shrink-0',
              changeDown ? 'text-emerald-500' : '',
              changeUp   ? 'text-red-400'     : '',
              changeNone ? 'text-gray-400'    : '',
            ].join(' ')}>
              {entry.changePct == null ? '—'
                : changeNone ? '→ 0%'
                : <>{changeDown ? '↓' : '↑'} {fmtPct(Math.abs(entry.changePct))}</>
              }
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Main Trends page ───────────────────────────────────────────────────────

export function Trends() {
  const { data, isLoading, isError } = useMonthlyTrends(6)
  const { data: cats } = useCategoryList()

  const lastIdx = (data?.months.length ?? 1) - 1
  const [selectedIdx, setSelectedIdx] = useState(lastIdx)

  // Reset to latest when data loads
  const months     = data?.months ?? []
  const categories = data?.categories ?? []
  const safeIdx    = Math.min(selectedIdx, Math.max(0, months.length - 1))

  const selectedMonth = months[safeIdx] ?? null
  const prevMonth     = safeIdx > 0 ? months[safeIdx - 1] : null
  const canGoPrev     = safeIdx > 0
  const canGoNext     = safeIdx < months.length - 1

  if (isLoading) {
    return (
      <div className="max-w-3xl flex items-center justify-center py-32 gap-2 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading trends…</span>
      </div>
    )
  }

  if (isError || months.length === 0) {
    return (
      <div className="max-w-3xl">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-12 text-center">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No trend data yet</p>
          <p className="text-xs text-gray-400">Scan a few receipts to see spending trends over time.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-0">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">

        {/* Section 1: Stacked bar chart */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[11px] uppercase tracking-widest font-semibold text-gray-400 mb-0.5">
                Monthly Spending
              </p>
              <p className="text-sm font-semibold text-gray-800">Last {months.length} months</p>
            </div>
            {selectedMonth && (
              <div className="text-right">
                <p className="text-xs text-gray-400 mb-0.5">{selectedMonth.month_label}</p>
                <p className="text-xl font-mono font-semibold tabular-nums text-gray-900">
                  {fmt(selectedMonth.total)}
                </p>
              </div>
            )}
          </div>

          <div className="w-full">
            <StackedBarChart
              data={{ months, categories }}
              selectedIdx={safeIdx}
              onSelect={setSelectedIdx}
              cats={cats}
            />
          </div>

          {/* Hint text instead of legend */}
          <p className="mt-2 text-[11px] text-gray-400 text-center">
            Hover or tap a segment to see category · click a bar to select month
          </p>
        </div>

        <div className="border-t border-gray-100" />

        {/* Section 2: Month breakdown */}
        {selectedMonth && (
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <button onClick={() => canGoPrev && setSelectedIdx(i => i - 1)} disabled={!canGoPrev}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  aria-label="Previous month">
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <div>
                  <p className="text-[11px] uppercase tracking-widest font-semibold text-gray-400 mb-0.5">
                    Breakdown
                  </p>
                  <p className="text-sm font-semibold text-gray-800">
                    {selectedMonth.month_label}
                    <span className="font-mono tabular-nums font-normal text-gray-500 ml-2">
                      · {fmt(selectedMonth.total)}
                    </span>
                  </p>
                </div>

                <button onClick={() => canGoNext && setSelectedIdx(i => i + 1)} disabled={!canGoNext}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  aria-label="Next month">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="hidden sm:flex items-center gap-3 text-[11px] uppercase tracking-widest font-semibold text-gray-400 pr-1">
                <span className="w-16 text-right">Amount</span>
                <span className="w-16 text-center">Avg</span>
                <span className="w-14 text-right">vs prev</span>
              </div>
            </div>

            <MonthBreakdown month={selectedMonth} prevMonth={prevMonth} allMonths={months} selIdx={safeIdx} cats={cats} />

            {prevMonth == null && (
              <p className="mt-3 text-[11px] text-gray-400 text-center">
                No previous month to compare against.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
