import { catColor, catIcon, fmtShort } from '../../lib/utils'
import type { Category } from '../../types'

interface CategoryBarChartProps {
  data: { category: string; amount: number }[]
  categories?: Category[]
}

export function CategoryBarChart({ data, categories }: CategoryBarChartProps) {
  const visible = data.filter(d => d.amount >= 5)
  const max = Math.max(...visible.map(d => d.amount), 1)
  const total = data.reduce((s, d) => s + d.amount, 0)

  return (
    <div className="space-y-3">
      {visible.map((d, i) => {
        const pct = (d.amount / max) * 100
        const share = ((d.amount / total) * 100).toFixed(0)
        const color = catColor(d.category, categories)
        return (
          <div key={d.category} className="group">
            <div className="flex items-center justify-between mb-1.5">
              <span className="flex items-center gap-2 text-sm text-gray-700 font-medium">
                <span className="text-base">{catIcon(d.category, categories)}</span>
                {d.category}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-gray-400">{share}%</span>
                <span className="text-sm font-mono font-semibold text-gray-800 tabular-nums w-14 text-right">
                  {fmtShort(d.amount)}
                </span>
              </div>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-700 ease-out"
                style={{
                  width: `${pct}%`,
                  background: color,
                  transitionDelay: `${i * 60}ms`,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
