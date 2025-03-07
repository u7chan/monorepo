import { Link, useNavigate } from '@tanstack/react-router'
import { type FC, type ReactNode, useEffect, useRef, useState } from 'react'
import { HamburgerIcon } from './svg/HamburgerIcon'
import { useResponsive } from './hooks/useResponsive'

interface Props {
  title: string
  version: string
  menuItems: {
    label: string
    to: string
  }[]
  children: ReactNode
}

export const Layout: FC<Props> = ({ title, version, menuItems, children }: Props) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const { mobile } = useResponsive()
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
        <>
          <header className='flex h-[56px] items-center justify-between bg-primary-800 px-4 text-white'>
            <h1 className='font-bold text-xl'>{title}</h1>
            <button
              type='button'
              className='rounded-lg border border-gray-300 p-2 hover:bg-primary-500 focus:outline-none focus:ring-2 focus:ring-gray-400'
              onClick={toggleMenu}
            >
              <HamburgerIcon color='#E0E0E0' />
            </button>
          </header>
          {menuOpen && (
            <div className='absolute right-4 mt-2 w-48 rounded border border-gray-200 bg-white shadow-lg'>
              <ul className='flex flex-col'>
                {menuItems.map((menuItem) => (
                  <button
                    key={menuItem.label}
                    type='button'
                    className='flex cursor-pointer justify-start px-4 py-3 hover:bg-gray-100'
                    onClick={() => {
                      navigate({ to: menuItem.to })
                      setMenuOpen(false)
                    }}
                  >
                    <Link to={menuItem.to}>{menuItem.label}</Link>
                  </button>
                ))}
                {version && (
                  <>
                    <hr />
                    <div className='items-bottom my-2 flex px-4'>
                      <span className='text-black text-sm'>{version}</span>
                    </div>
                  </>
                )}
              </ul>
            </div>
          )}
        </>
      )}
      <div className={`${mobile ? '' : 'flex'}`}>
        {/* Sidebar for PC or Tablet */}
        {!mobile && (
          <div className='flex h-screen w-40 flex-col justify-between bg-primary-800 px-2 py-4'>
            <div>
              <h1 className='mb-4 pl-2 font-bold text-white text-xl'>{title}</h1>
              <nav className='flex flex-col space-y-2'>
                {menuItems.map((menuItem) => (
                  <div key={menuItem.label}>
                    <Link
                      to={menuItem.to}
                      className='block rounded px-4 py-2 text-white transition duration-200 hover:bg-primary-700 [&.active]:bg-primary-700 [&.active]:font-bold'
                    >
                      {menuItem.label}
                    </Link>
                  </div>
                ))}
              </nav>
            </div>
            {version && <span className='text-sm text-white'>{version}</span>}
          </div>
        )}
        <main className='flex-1 bg-white'>{children}</main>
      </div>
    </div>
  )
}
