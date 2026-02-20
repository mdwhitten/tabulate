import { catColor } from '../lib/utils'
import type { Category } from '../types'

interface CategorySelectProps {
  value: string
  categories: Category[]
  onChange: (cat: string) => void
  disabled?: boolean
}

export function CategorySelect({ value, categories, onChange, disabled }: CategorySelectProps) {
  const color = catColor(value)
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-full appearance-none text-xs py-1.5 pl-3 pr-7 rounded-md border border-gray-200 bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent transition-shadow disabled:cursor-default disabled:opacity-70"
        style={{ borderLeftWidth: 3, borderLeftColor: color }}
      >
        {categories.map(c => (
          <option key={c.id} value={c.name}>{c.icon} {c.name}</option>
        ))}
      </select>
      {/* Custom chevron */}
      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  )
}
