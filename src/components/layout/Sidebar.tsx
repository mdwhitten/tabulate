import { LayoutDashboard, Receipt, TrendingUp, Tag, BookOpen, Camera, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Page } from '../../types'

interface NavItem {
  id: Page
  label: string
  icon: React.ReactNode
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard',    icon: <LayoutDashboard className="w-4 h-4" /> },
      { id: 'trends',    label: 'Trends',       icon: <TrendingUp       className="w-4 h-4" /> },
    ],
  },
  {
    section: 'Receipts',
    items: [
      { id: 'receipts',  label: 'All Receipts', icon: <Receipt          className="w-4 h-4" /> },
    ],
  },
  {
    section: 'Manage',
    items: [
      { id: 'categories', label: 'Categories',   icon: <Tag              className="w-4 h-4" /> },
      { id: 'learned',    label: 'Learned Items', icon: <BookOpen        className="w-4 h-4" /> },
    ],
  },
]

interface SidebarProps {
  current: Page
  onNavigate: (p: Page) => void
  onUpload: () => void
  mobileOpen: boolean
  onMobileClose: () => void
}

export function Sidebar({ current, onNavigate, onUpload, mobileOpen, onMobileClose }: SidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      {/* Sidebar panel */}
      <aside className={cn(
        'fixed top-0 left-0 h-screen w-60 bg-[#1c1c2e] flex flex-col z-30',
        'transition-transform duration-250 ease-in-out',
        'lg:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      )}>
        {/* Logo */}
        <div className="flex items-center justify-between px-5 h-16 shrink-0 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[var(--tab-accent)] rounded-xl flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-[var(--tab-accent)]/30">
              T
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-tight">Tabulate</p>
              <p className="text-[#4a4a6a] text-[10px] uppercase tracking-widest">Receipt Tracker</p>
            </div>
          </div>
          <button onClick={onMobileClose} className="lg:hidden text-gray-500 hover:text-gray-300 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
          {NAV.map(group => (
            <div key={group.section}>
              <p className="text-[10px] uppercase tracking-widest font-semibold text-[#4a4a6a] px-3 mb-2">
                {group.section}
              </p>
              <ul className="space-y-0.5">
                {group.items.map(item => {
                  const active = current === item.id
                  return (
                    <li key={item.id}>
                      <button
                        onClick={() => { onNavigate(item.id); onMobileClose() }}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all',
                          'border-l-2',
                          active
                            ? 'bg-white/10 text-white border-[var(--tab-accent)]'
                            : 'text-[#a0a0c0] hover:bg-white/5 hover:text-gray-200 border-transparent'
                        )}
                      >
                        <span className={active ? 'text-[var(--tab-accent)]' : 'opacity-70'}>{item.icon}</span>
                        {item.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Upload CTA */}
        <div className="px-3 py-4 shrink-0 border-t border-white/5">
          <button
            onClick={onUpload}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-[var(--tab-accent)] hover:bg-[var(--tab-accent-hover)] text-white text-sm font-semibold rounded-xl transition-colors shadow-lg shadow-[var(--tab-accent)]/25"
          >
            <Camera className="w-4 h-4" />
            Scan Receipt
          </button>
        </div>
      </aside>
    </>
  )
}
