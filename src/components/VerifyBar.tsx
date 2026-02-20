import { CheckCircle, AlertTriangle, AlertCircle, Plus } from 'lucide-react'
import { cn } from '../lib/utils'
import { fmt } from '../lib/utils'

type Status = 'verified' | 'warn' | 'fail'

interface VerifyBarProps {
  status: Status
  title: string
  detail: string
  /** Only shown in fail state — lets the user enter the total manually */
  onManualTotal?: (value: number) => void
  manualTotal?: number | null
  /** Shown in warn state — adds a line item for the remaining difference */
  onAddDifference?: (amount: number) => void
  /** The difference amount (receipt total minus computed sum) */
  difference?: number
}

const config: Record<Status, {
  border: string
  bg: string
  icon: React.ReactNode
}> = {
  verified: {
    border: 'border-l-green-500',
    bg: 'bg-white',
    icon: <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />,
  },
  warn: {
    border: 'border-l-orange-400',
    bg: 'bg-white',
    icon: <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0" />,
  },
  fail: {
    border: 'border-l-red-500',
    bg: 'bg-white',
    icon: <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />,
  },
}

export function VerifyBar({ status, title, detail, onManualTotal, manualTotal, onAddDifference, difference }: VerifyBarProps) {
  const { border, bg, icon } = config[status]
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-xl px-4 py-3 border-l-4 shadow-sm mb-2',
      border, bg
    )}>
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        <p className="text-xs text-gray-500 font-mono mt-0.5">{detail}</p>
      </div>
      {status === 'warn' && onAddDifference && difference != null && Math.abs(difference) >= 0.02 && (
        <button
          onClick={() => onAddDifference(difference)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-orange-600 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Add {fmt(Math.abs(difference))} item
        </button>
      )}
      {status === 'fail' && onManualTotal && (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-500 whitespace-nowrap">Enter total:</span>
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden bg-white shadow-sm">
            <span className="px-2 py-1.5 bg-gray-50 border-r border-gray-200 text-sm font-mono text-gray-400">$</span>
            <input
              type="text"
              inputMode="decimal"
              defaultValue={manualTotal?.toFixed(2) ?? ''}
              onFocus={e => e.target.select()}
              onChange={e => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v) && v > 0) onManualTotal(v)
              }}
              className="w-20 px-2 py-1.5 text-sm font-mono outline-none"
              placeholder="0.00"
            />
          </div>
        </div>
      )}
    </div>
  )
}
