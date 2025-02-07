import { Link, useNavigate } from '@tanstack/react-router'
import { type FC, type ReactNode, useEffect, useRef, useState } from 'react'
import { HamburgerIcon } from './svg/HamburgerIcon'

interface Props {
  title: string
  menuItems: {
    label: string
    to: string
  }[]
  children: ReactNode
}

const MOBILE = 600

export const Layout: FC<Props> = ({ title, menuItems, children }: Props) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const ref = useRef<HTMLDivElement>(null)

  const navigate = useNavigate()

  const toggleMenu = () => {
    setIsMenuOpen((prev) => !prev)
  }

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth
      setIsMobile(width < MOBILE)

      // スマホレイアウトになったらメニューを閉じる
      if (isMenuOpen && width >= MOBILE) {
        setIsMenuOpen(false)
      }
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [isMenuOpen])

  return (
    <div>
      {isMobile && (
        <header className='flex items-center justify-between bg-gray-100 px-4 py-2 text-black'>
          <h1 className='font-bold text-xl'>{title}</h1>
          <button
            type='button'
            className='rounded-lg bg-gray-200 p-2 hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-300'
            onClick={toggleMenu}
          >
            <HamburgerIcon />
          </button>
        </header>
      )}
      <div className={`flex bg-gray-100 ${isMobile ? '' : 'min-h-screen'}`} ref={ref}>
        {isMobile ? (
          <>
            {isMenuOpen && (
              <div className='absolute right-0 mt-2 w-48 rounded border border-gray-200 bg-white shadow-lg'>
                <ul className='flex flex-col py-2'>
                  {menuItems.map((menuItem) => (
                    <button
                      key={menuItem.label}
                      type='button'
                      className='flex cursor-pointer justify-start px-4 py-2 hover:bg-gray-100'
                      onClick={() => {
                        navigate({ to: menuItem.to })
                        setIsMenuOpen(false)
                      }}
                    >
                      <Link to={menuItem.to}>{menuItem.label}</Link>
                    </button>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <nav className='flex h-full flex-col space-y-4 p-4'>
            <h1 className='mb-4 font-bold text-xl'>{title}</h1>
            {menuItems.map((menuItem) => (
              <div key={menuItem.label}>
                <Link to={menuItem.to} className='text-gray-700 [&.active]:text-blue-700'>
                  {menuItem.label}
                </Link>
              </div>
            ))}
          </nav>
        )}
        <main className='flex-1 bg-white'>{children}</main>
      </div>
    </div>
  )
}
