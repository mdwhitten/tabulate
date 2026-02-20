import { useState, useImperativeHandle, forwardRef } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
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
  children: React.ReactNode
}

export const AppShell = forwardRef<AppShellRef, AppShellProps>(function AppShell(
  { currentPage, onNavigate, onUpload, topbarTitle, topbarLeft, topbarRight, children },
  ref
) {
  const [mobileOpen, setMobileOpen] = useState(false)

  useImperativeHandle(ref, () => ({
    closeSidebar: () => setMobileOpen(false),
  }))

  return (
    <div className="min-h-screen bg-[#f5f6fa]">
      <Sidebar
        current={currentPage}
        onNavigate={onNavigate}
        onUpload={onUpload}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <Topbar
        title={topbarTitle}
        left={topbarLeft}
        right={topbarRight}
        onMenuClick={() => setMobileOpen(true)}
      />
      {/* Content area — offset for fixed sidebar + topbar */}
      <main className="lg:ml-60 pt-12 min-h-screen">
        <div className="p-2 sm:p-4 lg:p-6 animate-[fadeUp_200ms_ease-out]">
          {children}
        </div>
      </main>
    </div>
  )
})
