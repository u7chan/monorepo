import { createRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { IconProps } from '../shared/icons/icon-base'
import { Route as RootRoute } from './__root'

const modules = import.meta.glob('../shared/icons/*-icon.tsx', { eager: true })

interface IconEntry {
  fileName: string
  componentName: string
  Component: React.ComponentType<IconProps & Record<string, unknown>>
}

interface VariantSpec {
  componentName: string
  variants: {
    label: string
    props: Partial<IconProps & Record<string, unknown>>
  }[]
}

const variantSpecs: VariantSpec[] = import.meta.env.DEV
  ? [
      {
        componentName: 'SidebarIcon',
        variants: [
          { label: 'collapse', props: { variant: 'collapse' } },
          { label: 'expand', props: { variant: 'expand' } },
        ],
      },
    ]
  : []

const icons: IconEntry[] = Object.entries(modules).map(([path, mod]) => {
  const fileName = path.split('/').pop() ?? ''
  const componentName = Object.keys(mod as Record<string, unknown>).find((k) => k.endsWith('Icon')) ?? ''
  const Component = (mod as Record<string, unknown>)[componentName] as React.ComponentType<
    IconProps & Record<string, unknown>
  >
  return { fileName, componentName, Component }
})

function findVariants(componentName: string) {
  return variantSpecs.find((spec) => spec.componentName === componentName)?.variants ?? []
}

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
        <h1 className='text-xl font-bold text-gray-900 dark:text-white'>SVG Icon Catalog</h1>
        <button
          type='button'
          onClick={toggleDark}
          className='rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:hover:bg-gray-800'
        >
          {isDark ? 'Light Mode' : 'Dark Mode'}
        </button>
      </div>
      <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'>
        {icons.map(({ fileName, componentName, Component }) => {
          const variants = findVariants(componentName)
          return (
            <div
              key={componentName}
              className='flex flex-col gap-2 rounded border border-gray-200 p-4 text-gray-900 dark:border-gray-700 dark:text-white'
            >
              <div className='text-blue-600 dark:text-blue-400'>
                <Component size={48} label={componentName} />
              </div>
              <span className='text-xs text-gray-500'>{componentName}</span>
              <span className='text-[10px] text-gray-400'>{fileName}</span>
              {variants.length > 0 && (
                <div className='mt-2 border-t border-gray-200 pt-2 dark:border-gray-700'>
                  <span className='text-[10px] font-semibold text-gray-400 uppercase tracking-wide'>Variants</span>
                  {variants.map((v) => (
                    <div key={v.label} className='mt-1 flex flex-col items-center gap-1'>
                      <div className='text-green-600 dark:text-green-400'>
                        <Component
                          size={48}
                          label={`${componentName} ${v.label}`}
                          {...(v.props as IconProps & Record<string, unknown>)}
                        />
                      </div>
                      <span className='text-[10px] text-gray-500'>{v.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
