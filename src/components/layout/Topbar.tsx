import { Menu } from 'lucide-react'

interface TopbarProps {
  title: string
  left?: React.ReactNode
  right?: React.ReactNode
  onMenuClick: () => void
  /** When true, hide hamburger and always span full width (no sidebar offset) */
  embedded?: boolean
}

export function Topbar({ title, left, right, onMenuClick, embedded }: TopbarProps) {
  return (
    <header className={[
      'fixed top-0 right-0 h-14 bg-white/80 backdrop-blur-sm border-b border-gray-200/70 flex items-center px-4 lg:px-6 gap-3 z-10',
      embedded ? 'left-0' : 'left-0 lg:left-60',
    ].join(' ')}>
      {/* Mobile hamburger — hidden in embedded (HA) mode */}
      {!embedded && (
        <button
          onClick={onMenuClick}
          className="lg:hidden p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* Left slot (back button etc.) */}
      {left && <div className="flex items-center">{left}</div>}

      {/* Title */}
      <h1 className="flex-1 text-sm font-semibold text-gray-800 truncate">{title}</h1>

      {/* Right slot */}
      {right && <div className="flex items-center gap-2">{right}</div>}
    </header>
  )
}
