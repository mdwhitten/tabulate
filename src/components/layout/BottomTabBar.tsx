import { LayoutDashboard, Receipt, TrendingUp, Tag, BookOpen, Camera } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Page } from '../../types'

interface TabItem {
  id: Page
  label: string
  icon: React.ReactNode
}

const TABS: TabItem[] = [
  { id: 'dashboard', label: 'Home',       icon: <LayoutDashboard className="w-5 h-5" /> },
  { id: 'receipts',  label: 'Receipts',   icon: <Receipt          className="w-5 h-5" /> },
  { id: 'trends',    label: 'Trends',     icon: <TrendingUp       className="w-5 h-5" /> },
  { id: 'categories', label: 'Categories', icon: <Tag              className="w-5 h-5" /> },
  { id: 'learned',   label: 'Learned',    icon: <BookOpen         className="w-5 h-5" /> },
]

interface BottomTabBarProps {
  current: Page
  onNavigate: (p: Page) => void
  onUpload: () => void
}

export function BottomTabBar({ current, onNavigate, onUpload }: BottomTabBarProps) {
  // Don't render tab bar on the review page — it has its own back-nav
  if (current === 'review') return null

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 safe-bottom">
      <div className="flex items-stretch justify-around h-14">
        {TABS.map(tab => {
          const active = current === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onNavigate(tab.id)}
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors',
                active
                  ? 'text-[#03a9f4]'
                  : 'text-gray-400 active:text-gray-600'
              )}
            >
              <span className={active ? 'text-[#03a9f4]' : 'text-gray-400'}>{tab.icon}</span>
              {tab.label}
            </button>
          )
        })}
        {/* Scan FAB-style tab */}
        <button
          onClick={onUpload}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-[#03a9f4] active:text-[#0290d1] transition-colors"
        >
          <span className="w-8 h-8 rounded-full bg-[#03a9f4] flex items-center justify-center shadow-md shadow-[#03a9f4]/30 -mt-1">
            <Camera className="w-4 h-4 text-white" />
          </span>
          Scan
        </button>
      </div>
    </nav>
  )
}
