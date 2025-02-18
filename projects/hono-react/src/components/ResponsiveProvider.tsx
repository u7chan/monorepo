import { type ReactNode, createContext, useContext, useEffect, useState } from 'react'

const MOBILE = 600

interface ResponsiveContextType {
  mobile: boolean
}

const ResponsiveContext = createContext<ResponsiveContextType | null>(null)

interface Props {
  children: ReactNode
}

export function ResponsiveProvider({ children }: Props) {
  const [mobile, setMobile] = useState(window.innerWidth < 768)

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth
      setMobile(width < MOBILE)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return <ResponsiveContext.Provider value={{ mobile }}>{children}</ResponsiveContext.Provider>
}

export function useResponsive(): ResponsiveContextType {
  const context = useContext(ResponsiveContext)
  if (!context) {
    throw new Error('useResponsive must be used within a ResponsiveProvider')
  }
  return context
}
