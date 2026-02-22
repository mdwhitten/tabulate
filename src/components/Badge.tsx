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

export function Badge({ variant }: { variant: Variant }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide whitespace-nowrap',
      styles[variant]
    )}>
      {labels[variant]}
    </span>
  )
}
