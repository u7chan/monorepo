import { useTheme } from '#/client/app/hooks/use-theme'
import { IconButton } from '#/client/shared/components/icon-button/icon-button'
import { MoonIcon } from '#/client/shared/icons/moon-icon'
import { SunIcon } from '#/client/shared/icons/sun-icon'

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
    <IconButton
      label={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
      onClick={toggleDarkMode}
      className={`rounded bg-gray-200 text-gray-700 transition-colors hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 ${sizeClasses[size]} ${className}`}
    >
      {isDark ? <SunIcon size={iconSize[size]} /> : <MoonIcon size={iconSize[size]} />}
    </IconButton>
  )
}
