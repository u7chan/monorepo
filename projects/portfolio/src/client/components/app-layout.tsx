import { Link } from '@tanstack/react-router'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { ThemeToggle } from './theme-toggle'

interface Props {
  version: string
  menuItems: {
    label: string
    icon: ReactNode
    to: string
  }[]
  children: ReactNode
}

export const AppLayout: FC<Props> = ({ version, menuItems, children }: Props) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  return (
    <div className={'flex'}>
      {/* デスクトップサイドバー */}
      <div className='hidden md:flex h-screen w-16 flex-col justify-between border-r bg-gray-100 px-2 py-4 dark:border-gray-700 dark:bg-gray-800'>
        {/* メニューリスト */}
        <nav className='flex flex-col space-y-2'>
          {menuItems.map((menuItem) => (
            <div key={menuItem.label}>
              {/* メニューリンク */}
              <Link
                to={menuItem.to}
                className='peer block w-12 rounded py-0.5 text-gray-400 transition duration-200 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700 [&.active]:bg-gray-200 [&.active]:text-blue-600 [&.active]:underline dark:[&.active]:bg-gray-700 dark:[&.active]:text-blue-400'
              >
                {/* アイコン */}
                <div className='my-0.5 flex max-h-5 items-center justify-center'>{menuItem.icon}</div>
                {/* ラベル */}
                <div className='flex justify-center text-[10px]'>{menuItem.label}</div>
              </Link>
            </div>
          ))}
        </nav>

        <div className='flex flex-col items-center space-y-2'>
          <ThemeToggle />
          {/* バージョン表示 */}
          <div className='flex justify-center'>
            <span className='text-[10px] text-gray-900 dark:text-white'>{version}</span>
          </div>
        </div>
      </div>

      {/* モバイルトップヘッダー */}
      <div className='md:hidden fixed top-0 left-0 right-0 h-14 bg-gray-100 dark:bg-gray-800 border-b dark:border-gray-700 z-50 flex items-center justify-between px-4'>
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className='p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700'
        >
          {/* ハンバーガーアイコン */}
          <svg
            className='w-6 h-6 text-gray-600 dark:text-gray-300'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M4 6h16M4 12h16M4 18h16' />
          </svg>
        </button>
        <span className='text-lg font-semibold text-gray-900 dark:text-white'>Portfolio</span>
        <ThemeToggle size='sm' />
      </div>

      {/* モバイルドロワーメニュー */}
      {isMobileMenuOpen && (
        <>
          <div className='md:hidden fixed inset-0 bg-black/50 z-50' onClick={() => setIsMobileMenuOpen(false)} />
          <div className='md:hidden fixed top-14 left-0 right-0 bg-gray-100 dark:bg-gray-800 border-b dark:border-gray-700 z-50 p-4'>
            <nav className='grid grid-cols-4 gap-2'>
              {menuItems.map((menuItem) => (
                <Link
                  key={menuItem.label}
                  to={menuItem.to}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className='flex flex-col items-center p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 [&.active]:text-blue-600 dark:[&.active]:text-blue-400'
                >
                  <div className='mb-1'>{menuItem.icon}</div>
                  <span className='text-[10px]'>{menuItem.label}</span>
                </Link>
              ))}
            </nav>
          </div>
        </>
      )}

      {/* メインコンテンツ */}
      <main className='flex-1 overflow-y-hidden bg-white md:overflow-y-auto dark:bg-gray-900 pt-14 md:pt-0'>
        {children}
      </main>
    </div>
  )
}
