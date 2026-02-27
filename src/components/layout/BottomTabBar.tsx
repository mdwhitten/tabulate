import { useEffect, useRef, useState } from 'react'
import { LayoutDashboard, Receipt, TrendingUp, Tag, BookOpen, Camera, Settings } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Page } from '../../types'

interface TabSubItem {
  id: Page
  label: string
  icon: React.ReactNode
}

interface TabGroup {
  label: string
  icon: React.ReactNode
  /** If single page, navigate directly — no popup */
  pages: TabSubItem[]
}

const TAB_GROUPS: TabGroup[] = [
  {
    label: 'Dashboard',
    icon: <LayoutDashboard className="w-5 h-5" />,
    pages: [
      { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
    ],
  },
  {
    label: 'Receipts',
    icon: <Receipt className="w-5 h-5" />,
    pages: [
      { id: 'receipts', label: 'All Receipts', icon: <Receipt className="w-4 h-4" /> },
    ],
  },
  {
    label: 'Trends',
    icon: <TrendingUp className="w-5 h-5" />,
    pages: [
      { id: 'trends', label: 'Trends', icon: <TrendingUp className="w-4 h-4" /> },
    ],
  },
  {
    label: 'Manage',
    icon: <Settings className="w-5 h-5" />,
    pages: [
      { id: 'categories', label: 'Categories',   icon: <Tag      className="w-4 h-4" /> },
      { id: 'learned',    label: 'Learned Items', icon: <BookOpen className="w-4 h-4" /> },
    ],
  },
]

interface BottomTabBarProps {
  current: Page
  onNavigate: (p: Page) => void
  onUpload: () => void
}

export function BottomTabBar({ current, onNavigate, onUpload }: BottomTabBarProps) {
  const [openGroup, setOpenGroup] = useState<number | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Close popup on outside tap
  useEffect(() => {
    if (openGroup === null) return
    function handleClick(e: MouseEvent) {
      // Check the parent wrapper (contains both popup and its toggle button)
      // so clicking the toggle doesn't race with the outside-close handler
      const wrapper = popupRef.current?.parentElement
      if (wrapper && !wrapper.contains(e.target as Node)) {
        setOpenGroup(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openGroup])

  // Hide during receipt review
  if (current === 'review') return null

  function isGroupActive(group: TabGroup) {
    return group.pages.some(p => p.id === current)
  }

  function handleTabClick(groupIdx: number) {
    const group = TAB_GROUPS[groupIdx]
    if (group.pages.length === 1) {
      // Single page — navigate directly
      setOpenGroup(null)
      onNavigate(group.pages[0].id)
    } else {
      // Toggle popup
      setOpenGroup(openGroup === groupIdx ? null : groupIdx)
    }
  }

  function handleSubItemClick(page: Page) {
    setOpenGroup(null)
    onNavigate(page)
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 safe-bottom">
      <div className="relative flex items-stretch justify-around h-14">
        {TAB_GROUPS.map((group, idx) => {
          const active = isGroupActive(group)
          const isOpen = openGroup === idx
          return (
            <div key={group.label} className="flex-1 relative flex items-center justify-center">
              {/* Popup menu */}
              {isOpen && group.pages.length > 1 && (
                <div
                  ref={popupRef}
                  className={cn(
                    'absolute bottom-full mb-2 bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden min-w-[160px] animate-[fadeUp_150ms_ease-out]',
                    idx === 0
                      ? 'left-2'
                      : idx === TAB_GROUPS.length - 1
                        ? 'right-2'
                        : 'left-1/2 -translate-x-1/2'
                  )}
                >
                  {group.pages.map(sub => {
                    const subActive = current === sub.id
                    return (
                      <button
                        key={sub.id}
                        onClick={() => handleSubItemClick(sub.id)}
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors',
                          subActive
                            ? 'text-[#03a9f4] bg-blue-50/60'
                            : 'text-gray-700 hover:bg-gray-50 active:bg-gray-100'
                        )}
                      >
                        <span className={subActive ? 'text-[#03a9f4]' : 'text-gray-400'}>{sub.icon}</span>
                        {sub.label}
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Tab button */}
              <button
                onClick={() => handleTabClick(idx)}
                className={cn(
                  'flex-1 h-full flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors rounded-lg',
                  active
                    ? 'text-[#03a9f4]'
                    : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 active:text-gray-600'
                )}
              >
                <span className={active ? 'text-[#03a9f4]' : 'text-gray-400'}>{group.icon}</span>
                {group.label}
              </button>
            </div>
          )
        })}

        {/* Scan tab */}
        <div className="flex-1 relative flex items-center justify-center">
          <button
            onClick={onUpload}
            className="flex-1 h-full flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-[#03a9f4] hover:bg-gray-100 active:text-[#0290d1] transition-colors rounded-lg"
          >
            <span className="w-7 h-7 rounded-full bg-[#03a9f4] flex items-center justify-center">
              <Camera className="w-3.5 h-3.5 text-white" />
            </span>
            <span className="-mt-0.5">Scan</span>
          </button>
        </div>
      </div>
    </nav>
  )
}
