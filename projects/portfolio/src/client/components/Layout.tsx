import { Link, useNavigate } from '@tanstack/react-router'
import { type FC, type ReactNode, useEffect, useState } from 'react'
import { useResponsive } from './hooks/useResponsive'
import { HamburgerIcon } from './svg/HamburgerIcon'

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
            <h1 className='font-bold text-xl'>Portfolio</h1>
            <button
              type='button'
              className='rounded-lg border border-gray-300 p-2 hover:bg-primary-500 focus:outline-none focus:ring-2 focus:ring-gray-400'
              onClick={toggleMenu}
            >
              <HamburgerIcon className='fill-[#E0E0E0]' />
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
          <div className='flex h-screen w-16 flex-col justify-between border-r bg-gray-100 px-2 py-4'>
            <nav className='flex flex-col space-y-2'>
              {menuItems.map((menuItem) => (
                <div key={menuItem.label}>
                  <Link
                    to={menuItem.to}
                    className='peer block rounded transition duration-200 hover:bg-gray-200 [&.active]:bg-gray-200'
                  >
                    <div className='flex h-12 w-12 items-center justify-center'>
                      {menuItem.icon}
                    </div>
                  </Link>
                  <div className='flex justify-center text-[10px] text-gray-400 peer-[&.active]:font-extrabold peer-[&.active]:text-primary-800'>
                    {menuItem.label}
                  </div>
                </div>
              ))}
            </nav>

            <div className='flex justify-center'>
              <span className='text-[10px] text-primary-800'>{version}</span>
            </div>
          </div>
        )}
        <main className='flex-1 overflow-y-hidden bg-white sm:overflow-y-auto'>{children}</main>
      </div>
    </div>
  )
}
