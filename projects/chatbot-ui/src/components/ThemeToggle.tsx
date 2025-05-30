import { Moon, Sun } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { useTheme } from '#/hooks/useTheme'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  const toggleTheme = () => {
    if (theme === 'light') {
      setTheme('dark')
    } else {
      setTheme('light')
    }
  }

  const getIcon = () => {
    switch (theme) {
      case 'light':
        return <Sun className='h-4 w-4' />
      case 'dark':
        return <Moon className='h-4 w-4' />
      default:
        return <Sun className='h-4 w-4' />
    }
  }

  const getLabel = () => {
    switch (theme) {
      case 'light':
        return 'ライトモード'
      case 'dark':
        return 'ダークモード'
      default:
        return 'ライトモード'
    }
  }

  return (
    <Button
      variant='outline'
      size='sm'
      onClick={toggleTheme}
      className='gap-2'
      title={`現在: ${getLabel()}`}
    >
      {getIcon()}
      <span className='hidden sm:inline'>{getLabel()}</span>
    </Button>
  )
}
