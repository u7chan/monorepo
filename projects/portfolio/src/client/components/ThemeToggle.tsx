import { useEffect, useState } from 'react'

interface ThemeToggleProps {
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function ThemeToggle({ className = '', size = 'md' }: ThemeToggleProps) {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme')
      if (saved === 'dark') return true
      if (saved === 'light') return false
      return document.documentElement.classList.contains('dark')
    }
    return false
  })

  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (isDark) {
        document.documentElement.classList.add('dark')
        localStorage.setItem('theme', 'dark')
      } else {
        document.documentElement.classList.remove('dark')
        localStorage.setItem('theme', 'light')
      }
    }
  }, [isDark])

  const toggleDarkMode = () => {
    setIsDark((prev) => !prev)
  }

  const sizeClasses = {
    sm: 'h-6 w-6 text-xs',
    md: 'h-8 w-8 text-sm',
    lg: 'h-10 w-10 text-base',
  }

  return (
    <button
      type='button'
      onClick={toggleDarkMode}
      aria-label={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
      className={`flex items-center justify-center rounded bg-gray-200 text-gray-700 transition-colors hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 ${sizeClasses[size]} ${className}`}
    >
      {isDark ? (
        <svg
          xmlns='http://www.w3.org/2000/svg'
          viewBox='0 0 24 24'
          fill='currentColor'
          width='1em'
          height='1em'
          aria-label='ライトモード'
        >
          <title>ライトモード</title>
          <circle cx='12' cy='12' r='5' />
          <g>
            <line x1='12' y1='1' x2='12' y2='3' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            <line x1='12' y1='21' x2='12' y2='23' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            <line x1='4.22' y1='4.22' x2='5.64' y2='5.64' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            <line
              x1='18.36'
              y1='18.36'
              x2='19.78'
              y2='19.78'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
            />
            <line x1='1' y1='12' x2='3' y2='12' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            <line x1='21' y1='12' x2='23' y2='12' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            <line
              x1='4.22'
              y1='19.78'
              x2='5.64'
              y2='18.36'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
            />
            <line
              x1='18.36'
              y1='5.64'
              x2='19.78'
              y2='4.22'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
            />
          </g>
        </svg>
      ) : (
        <svg
          xmlns='http://www.w3.org/2000/svg'
          viewBox='0 0 24 24'
          fill='currentColor'
          width='1em'
          height='1em'
          aria-label='ダークモード'
        >
          <title>ダークモード</title>
          <g transform='scale(-1,1) translate(-24,0)'>
            <path d='M21 12.79A9 9 0 0 1 12.79 3a7 7 0 1 0 8.21 9.79z' />
          </g>
        </svg>
      )}
    </button>
  )
}
