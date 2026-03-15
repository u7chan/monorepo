import { copyToClipboard } from '#/client/components/chat/copy-to-clipboard'
import { useCallback, useState } from 'react'

export function useMessageCopy() {
  const [copiedId, setCopiedId] = useState('')

  const copyMessage = useCallback(async (message: string, index: number) => {
    setCopiedId(`chat_${index}`)
    try {
      await copyToClipboard(message)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } catch (error) {
      alert(error)
    }
    setCopiedId('')
  }, [])

  return {
    copiedId,
    copyMessage,
  }
}
