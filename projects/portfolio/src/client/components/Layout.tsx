import { Link } from '@tanstack/react-router'
import type { FC, ReactNode } from 'react'

interface Props {
  version: string
  menuItems: {
    label: string
    icon: ReactNode
    to: string
  }[]
  children: ReactNode
}

export const Layout: FC<Props> = ({ version, menuItems, children }: Props) => {
  return (
    <div className={'flex'}>
      {/* サイドバー */}
      <div className='flex h-screen w-16 flex-col justify-between border-r bg-gray-100 px-2 py-4 dark:border-gray-700 dark:bg-gray-800'>
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
                <div className='my-0.5 flex max-h-[20px] items-center justify-center'>
                  {menuItem.icon}
                </div>
                {/* ラベル */}
                <div className='flex justify-center text-[10px]'>{menuItem.label}</div>
              </Link>
            </div>
          ))}
        </nav>

        <div className='flex flex-col items-center space-y-2'>
          {/* バージョン表示 */}
          <div className='flex justify-center'>
            <span className='text-[10px] text-gray-900 dark:text-white'>{version}</span>
          </div>
        </div>
      </div>
      {/* メインコンテンツ */}
      <main className='flex-1 overflow-y-hidden bg-white sm:overflow-y-auto dark:bg-gray-900'>
        {children}
      </main>
    </div>
  )
}
