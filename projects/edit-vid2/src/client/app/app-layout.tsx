import { Link } from '@tanstack/react-router'
import { Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTheme } from '#/client/app/use-theme'

interface Props {
  menuItems: {
    label: string
    icon: ReactNode
    to: string
  }[]
  children: ReactNode
}

export function AppLayout({ menuItems, children }: Props) {
  const { isDark, toggle } = useTheme()

  return (
    <div className='flex min-h-dvh overflow-hidden md:h-dvh'>
      <div className='hidden h-dvh w-16 flex-col justify-between border-r bg-gray-100 px-2 py-4 dark:border-gray-700 dark:bg-gray-800 md:flex'>
        <nav className='flex flex-col space-y-2'>
          {menuItems.map((menuItem) => (
            <div key={menuItem.label}>
              <Link
                to={menuItem.to}
                className='peer block w-12 rounded py-0.5 text-gray-400 transition duration-200 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700 [&.active]:bg-gray-200 [&.active]:text-indigo-600 dark:[&.active]:bg-gray-700 dark:[&.active]:text-indigo-400'
              >
                <div className='my-0.5 flex max-h-5 items-center justify-center'>{menuItem.icon}</div>
                <div className='flex justify-center text-[10px]'>{menuItem.label}</div>
              </Link>
            </div>
          ))}
        </nav>
        <button
          type='button'
          onClick={toggle}
          className='flex h-10 w-10 items-center justify-center self-center rounded text-gray-400 transition duration-200 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'
          aria-label={isDark ? 'ライトモード' : 'ダークモード'}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
      <main className='min-h-0 min-w-0 flex-1 overflow-y-auto bg-white pt-14 dark:bg-gray-900 md:pt-0'>{children}</main>
    </div>
  )
}
