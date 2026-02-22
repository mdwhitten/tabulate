import { useState, useImperativeHandle, forwardRef } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { BottomTabBar } from './BottomTabBar'
import type { Page } from '../../types'

export interface AppShellRef {
  closeSidebar: () => void
}

interface AppShellProps {
  currentPage: Page
  onNavigate: (p: Page) => void
  onUpload: () => void
  topbarTitle: string
  topbarLeft?: React.ReactNode
  topbarRight?: React.ReactNode
  /** When true, hide sidebar and show bottom tab bar instead (e.g. HA add-on) */
  embedded?: boolean
  children: React.ReactNode
}

export const AppShell = forwardRef<AppShellRef, AppShellProps>(function AppShell(
  { currentPage, onNavigate, onUpload, topbarTitle, topbarLeft, topbarRight, embedded, children },
  ref
) {
  const [mobileOpen, setMobileOpen] = useState(false)

  useImperativeHandle(ref, () => ({
    closeSidebar: () => setMobileOpen(false),
  }))

  return (
    <div className="min-h-screen bg-[#f5f6fa]">
      {embedded ? (
        <BottomTabBar
          current={currentPage}
          onNavigate={onNavigate}
          onUpload={onUpload}
        />
      ) : (
        <Sidebar
          current={currentPage}
          onNavigate={onNavigate}
          onUpload={onUpload}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
      )}
      <Topbar
        title={topbarTitle}
        left={topbarLeft}
        right={topbarRight}
        onMenuClick={() => setMobileOpen(true)}
        embedded={embedded}
      />
      {/* Content area — offset for fixed sidebar + topbar; bottom padding for tab bar */}
      <main className={embedded ? 'pt-12 pb-20 min-h-screen' : 'lg:ml-60 pt-12 min-h-screen'}>
        <div className="p-2 sm:p-4 lg:p-6 animate-[fadeUp_200ms_ease-out]">
          {children}
        </div>
      </main>
    </div>
  )
})
