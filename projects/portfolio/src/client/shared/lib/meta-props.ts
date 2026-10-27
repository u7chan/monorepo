export type MetaProps = {
  email?: string
  loginExpiresLabel?: string | null
}

/**
 * サーバーが HTML へ埋め込む props。
 * ルートの beforeLoad でも使うため、React の外からも読める関数として切り出している。
 */
export function readMetaProps(): MetaProps {
  const meta = document.querySelector('meta[name="props"]')
  const content = meta?.getAttribute('content')
  if (!content) return {}

  try {
    return JSON.parse(content) as MetaProps
  } catch (error) {
    console.error('Failed to parse meta props content', error)
    return {}
  }
}

export const isSignedIn = (): boolean => !!readMetaProps().email
