import { cn } from '../lib/utils'

import type { ReceiptStatus } from '../types'

type Variant = ReceiptStatus

const styles: Record<Variant, string> = {
  verified:   'bg-green-100 text-green-700',
  review:     'bg-orange-100 text-orange-700',
  pending:    'bg-gray-100 text-gray-500',
  processing: 'bg-sky-100 text-sky-700 animate-pulse',
  failed:     'bg-red-100 text-red-700',
}

const labels: Record<Variant, string> = {
  verified:   '✓ Approved',
  review:     'Review Math',
  pending:    'Pending',
  processing: 'Processing…',
  failed:     'Failed',
}

const icons: Record<Variant, string> = {
  verified:   '✓',
  review:     '!',
  pending:    '·',
  processing: '…',
  failed:     '✕',
}

interface BadgeProps {
  variant: Variant
  compact?: boolean
}

export function Badge({ variant, compact }: BadgeProps) {
  if (compact) {
    return (
      <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold', styles[variant])}
        title={labels[variant]}>
        {icons[variant]}
      </span>
    )
  }

  return (
    <span className={cn(
      'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide whitespace-nowrap',
      styles[variant]
    )}>
      {labels[variant]}
    </span>
  )
}
