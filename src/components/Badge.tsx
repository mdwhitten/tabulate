import { cn } from '../lib/utils'

type Variant = 'verified' | 'review' | 'pending'

const styles: Record<Variant, string> = {
  verified: 'bg-green-100 text-green-700',
  review:   'bg-orange-100 text-orange-700',
  pending:  'bg-gray-100 text-gray-500',
}

const labels: Record<Variant, string> = {
  verified: '✓ Approved',
  review:   'Review Math',
  pending:  'Pending',
}

const icons: Record<Variant, string> = {
  verified: '✓',
  review:   '!',
  pending:  '·',
}

const dotColors: Record<Variant, string> = {
  verified: 'bg-green-500',
  review:   'bg-orange-400',
  pending:  'bg-gray-300',
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
