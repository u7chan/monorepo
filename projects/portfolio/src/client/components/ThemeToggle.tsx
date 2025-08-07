import { useState } from 'react'

interface ThemeToggleProps {
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function ThemeToggle({ className = '', size = 'md' }: ThemeToggleProps) {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })

  const toggleDarkMode = () => {
    setIsDark((prev) => {
      const next = !prev
      if (next) {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
      return next
    })
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
        <span role='img' aria-label='ライトモード'>
          ☀️
        </span>
      ) : (
        <span role='img' aria-label='ダークモード'>
          🌙
        </span>
      )}
    </button>
  )
}
