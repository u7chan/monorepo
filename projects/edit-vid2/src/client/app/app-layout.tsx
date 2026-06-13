import { Link } from '@tanstack/react-router'
import { Menu, Moon, Sun, X } from 'lucide-react'
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTheme } from '#/client/app/use-theme'

interface Props {
  menuItems: {
    label: string
    icon: ReactNode
    to: string
  }[]
  children: ReactNode
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null
  )
}

export function AppLayout({ menuItems, children }: Props) {
  const { isDark, toggle } = useTheme()
  const [isOpen, setIsOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const focusResetRef = useRef(false)

  const close = useCallback(() => {
    focusResetRef.current = false
    setIsOpen(false)
  }, [])

  const handleDrawerRef = useCallback((node: HTMLDivElement | null) => {
    drawerRef.current = node
    if (!node || focusResetRef.current) return
    focusResetRef.current = true
    const focusable = getFocusableElements(node)
    focusable[0]?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }

    if (event.key !== 'Tab') return

    const focusable = getFocusableElements(drawerRef.current)
    if (focusable.length === 0) return

    const current = focusable.findIndex((el) => el === document.activeElement)
    if (current === -1) return

    event.preventDefault()
    const nextIndex = event.shiftKey
      ? (current - 1 + focusable.length) % focusable.length
      : (current + 1) % focusable.length
    focusable[nextIndex]?.focus()
  }

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

      <header className='fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b bg-white px-4 dark:border-gray-700 dark:bg-gray-900 md:hidden'>
        <span className='font-semibold text-gray-900 dark:text-white'>edit-vid2</span>
        <button
          type='button'
          onClick={() => setIsOpen(true)}
          className='flex h-10 w-10 items-center justify-center rounded text-gray-500 transition duration-200 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
          aria-label='メニューを開く'
          aria-expanded={isOpen}
          aria-controls='mobile-menu'
        >
          <Menu size={22} />
        </button>
      </header>

      {isOpen && (
        <>
          <div className='fixed inset-0 z-50 bg-black/50 md:hidden' onClick={close} aria-hidden='true' />
          <div
            ref={handleDrawerRef}
            id='mobile-menu'
            className='fixed left-0 top-14 bottom-0 z-50 w-64 border-r bg-gray-100 px-4 py-4 outline-none dark:border-gray-700 dark:bg-gray-800 md:hidden'
            role='dialog'
            aria-modal='true'
            aria-label='ナビゲーションメニュー'
            tabIndex={-1}
            onKeyDown={handleKeyDown}
          >
            <div className='flex h-full flex-col'>
              <button
                type='button'
                onClick={close}
                className='absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded text-gray-500 transition duration-200 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'
                aria-label='メニューを閉じる'
              >
                <X size={18} />
              </button>
              <nav className='flex-1 space-y-1 pt-8'>
                {menuItems.map((menuItem) => (
                  <Link
                    key={menuItem.label}
                    to={menuItem.to}
                    onClick={close}
                    className='flex items-center space-x-3 rounded px-3 py-3 text-gray-600 transition duration-200 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700 [&.active]:bg-gray-200 [&.active]:text-indigo-600 dark:[&.active]:bg-gray-700 dark:[&.active]:text-indigo-400'
                  >
                    <span className='flex h-5 w-5 items-center justify-center'>{menuItem.icon}</span>
                    <span className='text-sm font-medium'>{menuItem.label}</span>
                  </Link>
                ))}
              </nav>
              <button
                type='button'
                onClick={toggle}
                className='flex w-full items-center space-x-3 rounded px-3 py-3 text-gray-600 transition duration-200 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'
                aria-label={isDark ? 'ライトモード' : 'ダークモード'}
              >
                <span className='flex h-5 w-5 items-center justify-center'>
                  {isDark ? <Sun size={18} /> : <Moon size={18} />}
                </span>
                <span className='text-sm font-medium'>{isDark ? 'ライトモード' : 'ダークモード'}</span>
              </button>
            </div>
          </div>
        </>
      )}

      <main className='min-h-0 min-w-0 flex-1 overflow-y-auto bg-white pt-14 dark:bg-gray-900 md:pt-0'>{children}</main>
    </div>
  )
}
