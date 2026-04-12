import { useTheme } from '../hooks/use-theme'
import { MoonIcon } from './svg/moon-icon'
import { SunIcon } from './svg/sun-icon'

interface ThemeToggleProps {
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function ThemeToggle({ className = '', size = 'md' }: ThemeToggleProps) {
  const { isDark, toggleDarkMode } = useTheme()

  const sizeClasses = {
    sm: 'h-6 w-6 text-xs',
    md: 'h-8 w-8 text-sm',
    lg: 'h-10 w-10 text-base',
  }

  const iconSize = { sm: 14, md: 16, lg: 20 }

  return (
    <button
      type='button'
      onClick={toggleDarkMode}
      aria-label={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
      className={`flex items-center justify-center rounded bg-gray-200 text-gray-700 transition-colors hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 ${sizeClasses[size]} ${className}`}
    >
      {isDark ? (
        <SunIcon size={iconSize[size]} className='stroke-current' />
      ) : (
        <MoonIcon size={iconSize[size]} className='fill-current' />
      )}
    </button>
  )
}
