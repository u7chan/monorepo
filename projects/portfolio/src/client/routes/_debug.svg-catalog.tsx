import { createRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Route as RootRoute } from './__root'

const modules = import.meta.glob('../components/svg/*-icon.tsx', { eager: true })

interface IconEntry {
  fileName: string
  componentName: string
  Component: React.FC<{ size?: number }>
}

const icons: IconEntry[] = Object.entries(modules).map(([path, mod]) => {
  const fileName = path.split('/').pop() ?? ''
  const componentName = Object.keys(mod as Record<string, unknown>).find((k) => k.endsWith('Icon')) ?? ''
  const Component = (mod as Record<string, unknown>)[componentName] as React.FC<{ size?: number }>
  return { fileName, componentName, Component }
})

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/debug/svg-catalog',
  component: SvgCatalog,
})

function SvgCatalog() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }
    const saved = localStorage.getItem('theme')
    if (saved === 'dark') {
      return true
    }
    if (saved === 'light') {
      return false
    }
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const syncTheme = () => {
      const saved = localStorage.getItem('theme')
      if (saved === 'dark') {
        setIsDark(true)
        return
      }
      if (saved === 'light') {
        setIsDark(false)
        return
      }
      setIsDark(document.documentElement.classList.contains('dark'))
    }

    syncTheme()

    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('storage', syncTheme)

    return () => {
      observer.disconnect()
      window.removeEventListener('storage', syncTheme)
    }
  }, [])

  const toggleDark = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <div className='p-4'>
      <div className='mb-4 flex items-center justify-between'>
        <h1 className='text-xl font-bold'>SVG Icon Catalog</h1>
        <button
          type='button'
          onClick={toggleDark}
          className='rounded border px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800'
        >
          {isDark ? 'Light Mode' : 'Dark Mode'}
        </button>
      </div>
      <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'>
        {icons.map(({ fileName, componentName, Component }) => (
          <div key={componentName} className='flex flex-col items-center gap-2 rounded border p-4'>
            <Component size={32} />
            <span className='text-xs text-gray-500'>{componentName}</span>
            <span className='text-[10px] text-gray-400'>{fileName}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
