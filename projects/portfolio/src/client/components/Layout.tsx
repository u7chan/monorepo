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
      <div className='flex h-screen w-16 flex-col justify-between border-r bg-gray-100 px-2 py-4'>
        {/* メニューリスト */}
        <nav className='flex flex-col space-y-2'>
          {menuItems.map((menuItem) => (
            <div key={menuItem.label}>
              {/* メニューリンク */}
              <Link
                to={menuItem.to}
                className='peer block w-12 rounded py-0.5 text-gray-400 transition duration-200 hover:bg-gray-200 [&.active]:bg-gray-200 [&.active]:text-primary-800 [&.active]:underline'
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
        {/* バージョン表示 */}
        <div className='flex justify-center'>
          <span className='text-[10px] text-primary-800'>{version}</span>
        </div>
      </div>
      {/* メインコンテンツ */}
      <main className='flex-1 overflow-y-hidden bg-white sm:overflow-y-auto'>{children}</main>
    </div>
  )
}
