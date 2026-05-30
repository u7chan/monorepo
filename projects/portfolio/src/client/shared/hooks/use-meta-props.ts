import { useMemo } from 'react'

type Props = {
  email?: string
  loginExpiresLabel?: string | null
}

export function useMetaProps(): Props {
  return useMemo(() => {
    const meta = document.querySelector('meta[name="props"]')
    if (!meta) return {}

    const content = meta.getAttribute('content')
    if (!content) return {}

    try {
      return JSON.parse(content)
    } catch (error) {
      console.error('Failed to parse meta props content', error)
      return {}
    }
  }, [])
}
