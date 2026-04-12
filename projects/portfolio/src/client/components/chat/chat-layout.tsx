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
        className={`fixed top-14 bottom-0 left-0 z-50 w-64 border-gray-200 border-r bg-white dark:border-gray-700 dark:bg-gray-800 transform transition-transform duration-300 ease-in-out md:relative md:top-0 md:translate-x-0 md:w-56 md:z-auto ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {conversations}
      </div>

      {/* オーバーレイ背景 - モバイルのみ */}
      {isSidebarOpen && (
        <div className='fixed top-14 bottom-0 left-0 right-0 bg-black/50 z-40 md:hidden' onClick={onToggleSidebar} />
      )}

      <div className='flex h-full min-h-0 flex-1 flex-col bg-white dark:bg-gray-900'>{children}</div>
    </div>
  ) : (
    <div className='flex h-[calc(100dvh-3.5rem)] flex-col bg-white md:h-dvh dark:bg-gray-900'>{children}</div>
  )
}
