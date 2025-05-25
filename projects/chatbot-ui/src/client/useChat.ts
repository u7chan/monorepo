import { useEffect, useRef, useState } from 'react'
import type { Message } from '#/components/MessageArea'

export function useChat() {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // メッセージの状態管理
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'こんにちは！\n何かお手伝いできることはありますか？',
      sender: 'bot',
      timestamp: new Date(),
    },
  ])
  // ストリーミングの状態管理
  const [streaming, setStreaming] = useState({
    state: 'idle' as 'idle' | 'streaming',
    text: '',
    abortController: null as AbortController | null,
    error: null as Error | null,
  })

  // メッセージ送信処理
  const handleSendMessage = async (message: string) => {
    const abortController = new AbortController()
    setStreaming({
      state: 'streaming',
      text: '',
      abortController,
      error: null,
    })

    // ユーザーメッセージを追加
    const userMessage: Message = {
      id: Date.now().toString(),
      content: message,
      sender: 'user',
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
      signal: abortController.signal,
    })

    if (response.ok) {
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Failed to get reader from response body.')
      }

      let chunks = ''

      const decoder = new TextDecoder('utf-8')
      let done = false

      while (!done) {
        const { done: isDone, value } = await reader.read()
        done = isDone

        if (value) {
          chunks += decoder.decode(value, { stream: true })
          setStreaming((p) => ({ ...p, text: `${chunks}` }))
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          content: chunks,
          sender: 'bot',
          timestamp: new Date(),
        },
      ])
    }

    setStreaming({
      state: 'idle',
      text: '',
      abortController: null,
      error: null,
    })
  }

  const handleSendMessageCancel = () => {
    if (!streaming.abortController) {
      return
    }
    streaming.abortController.abort()
    setStreaming({
      state: 'idle',
      text: '',
      abortController: null,
      error: null,
    })
  }

  useEffect(() => {
    // メッセージが更新されたときにスクロール
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  return {
    messages,
    messagesEndRef,
    streaming,
    handleSendMessage,
    handleSendMessageCancel,
  }
}
