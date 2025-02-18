import { Link, useNavigate } from '@tanstack/react-router'
import { type FC, type ReactNode, useEffect, useRef, useState } from 'react'
import { HamburgerIcon } from './svg/HamburgerIcon'
import { useResponsive } from './ResponsiveProvider'

interface Props {
  title: string
  menuItems: {
    label: string
    to: string
  }[]
  children: ReactNode
}

export const Layout: FC<Props> = ({ title, menuItems, children }: Props) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const { mobile } = useResponsive()
  const ref = useRef<HTMLDivElement>(null)

  const navigate = useNavigate()

  const toggleMenu = () => {
    setMenuOpen((prev) => !prev)
  }

  useEffect(() => {
    if (!mobile && menuOpen) {
      setMenuOpen(false)
    }
  }, [mobile, menuOpen])

  return (
    <div>
      {mobile && (
        <header className='flex h-[56px] items-center justify-between bg-gray-100 px-4 text-black'>
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
      <div className={`flex bg-gray-100 ${mobile ? '' : 'min-h-screen'}`} ref={ref}>
        {mobile ? (
          <>
            {menuOpen && (
              <div className='absolute right-0 mt-2 w-48 rounded border border-gray-200 bg-white shadow-lg'>
                <ul className='flex flex-col py-2'>
                  {menuItems.map((menuItem) => (
                    <button
                      key={menuItem.label}
                      type='button'
                      className='flex cursor-pointer justify-start px-4 py-2 hover:bg-gray-100'
                      onClick={() => {
                        navigate({ to: menuItem.to })
                        setMenuOpen(false)
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
