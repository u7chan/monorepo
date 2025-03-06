import { useEffect, useState } from 'react'

const MOBILE = 600

export function useResponsive() {
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

  return { mobile }
}
