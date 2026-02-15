import type { PropsWithChildren, ReactNode } from 'react'

interface Props {
  conversations?: ReactNode
  isSidebarOpen?: boolean
  onToggleSidebar?: () => void
}

export function ChatLayout({ conversations, isSidebarOpen, onToggleSidebar, children }: PropsWithChildren<Props>) {
  return conversations ? (
    <div className='flex h-[calc(100dvh-3.5rem)] overflow-hidden bg-white md:h-dvh dark:bg-gray-900'>
      {/* サイドバー - モバイルではドロワー、デスクトップでは常時表示 */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 min-h-screen border-gray-200 border-r bg-white dark:border-gray-700 dark:bg-gray-800 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 md:w-40 md:z-auto ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {conversations}
      </div>

      {/* オーバーレイ背景 - モバイルのみ */}
      {isSidebarOpen && <div className='fixed inset-0 bg-black/50 z-40 md:hidden' onClick={onToggleSidebar} />}

      <div className='flex h-full flex-1 bg-white dark:bg-gray-900'>{children}</div>
    </div>
  ) : (
    <div className='h-[calc(100dvh-3.5rem)] bg-white md:h-dvh dark:bg-gray-900'>{children}</div>
  )
}
