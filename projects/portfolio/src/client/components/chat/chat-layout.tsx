import type { PropsWithChildren, ReactNode } from 'react'

interface Props {
  conversations?: ReactNode
  isSidebarOpen?: boolean
  onToggleSidebar?: () => void
}

export function ChatLayout({ conversations, isSidebarOpen, onToggleSidebar, children }: PropsWithChildren<Props>) {
  return conversations ? (
    <div className='flex h-[calc(100dvh-3.5rem)] overflow-hidden bg-white md:h-dvh dark:bg-gray-900'>
      {/* モバイル用ドロワー */}
      <div
        className={`fixed top-14 bottom-0 left-0 z-50 w-64 bg-white dark:bg-gray-800 transform transition-transform duration-300 ease-in-out md:hidden ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className='h-full border-gray-200 border-r dark:border-gray-700'>{conversations}</div>
      </div>

      {/* オーバーレイ背景 - モバイルのみ */}
      {isSidebarOpen && (
        <div className='fixed top-14 bottom-0 left-0 right-0 bg-black/50 z-40 md:hidden' onClick={onToggleSidebar} />
      )}

      {/* デスクトップ用サイドバー（幅アニメーション） */}
      <div
        className={`hidden md:block shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
          isSidebarOpen ? 'w-56' : 'w-0'
        }`}
      >
        <div className='h-full w-56 border-gray-200 border-r bg-gray-50 dark:border-gray-700 dark:bg-gray-800'>
          {conversations}
        </div>
      </div>

      <div className='min-w-0 flex h-full min-h-0 flex-1 flex-col bg-white dark:bg-gray-900'>{children}</div>
    </div>
  ) : (
    <div className='flex h-[calc(100dvh-3.5rem)] flex-col bg-white md:h-dvh dark:bg-gray-900'>{children}</div>
  )
}
