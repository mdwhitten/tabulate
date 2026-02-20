import { useState } from 'react'
import { fmt } from '../lib/utils'

interface PriceInputProps {
  lineTotal: number
  locked?: boolean
  /** If true, displays price in green with a leading − sign (discount row) */
  negative?: boolean
  onChange: (newLineTotal: number) => void
}

export function PriceInput({ lineTotal, locked, negative, onChange }: PriceInputProps) {
  // Store absolute value in the input; negative flag controls sign
  const absTotal = Math.abs(lineTotal)
  const [value, setValue] = useState(absTotal.toFixed(2))
  const [focused, setFocused] = useState(false)

  if (locked) {
    return (
      <span className={['font-mono font-medium text-sm tabular-nums', negative ? 'text-emerald-600' : ''].join(' ')}>
        {negative ? '−' : ''}{fmt(absTotal)}
      </span>
    )
  }

  return (
    <div className={`inline-flex items-center border rounded-lg overflow-hidden transition-shadow ${
      focused
        ? 'border-blue-400 shadow-[0_0_0_3px_rgba(59,130,246,0.15)]'
        : 'border-gray-200 hover:border-gray-300'
    }`}>
      <span className={['px-1.5 py-1 bg-gray-50 border-r border-gray-200 text-xs font-mono select-none', negative ? 'text-emerald-500' : 'text-gray-400'].join(' ')}>
        {negative ? '−$' : '$'}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onFocus={e => { setFocused(true); e.target.select() }}
        onBlur={() => {
          setFocused(false)
          const n = parseFloat(value)
          if (isNaN(n) || n < 0) {
            setValue(absTotal.toFixed(2))
          } else {
            setValue(n.toFixed(2))
            // pass back with correct sign
            onChange(negative ? -n : n)
          }
        }}
        onChange={e => {
          setValue(e.target.value)
          const n = parseFloat(e.target.value)
          if (!isNaN(n) && n >= 0) onChange(negative ? -n : n)
        }}
        className={['w-16 px-1.5 py-1 text-sm font-mono font-medium text-right bg-white outline-none tabular-nums', negative ? 'text-emerald-600' : ''].join(' ')}
      />
    </div>
  )
}
