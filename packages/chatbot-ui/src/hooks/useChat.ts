import { hc } from 'hono/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '#/components/MessageArea'
import type { AppType } from '#/server/app'

const client = hc<AppType>('/')

const NEAR_BOTTOM_THRESHOLD = 200 // 200px以内なら一番下とみなす

export function useChat() {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true)
  const scrollTimeoutRef = useRef<number | null>(null)
  const lastScrollTimeRef = useRef<number>(0)

  // メッセージの状態管理
  const [messages, setMessages] = useState<Message[]>([
    {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: 'こんにちは！\n何かお手伝いできることはありますか？',
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
      role: 'user',
      content: message,
      timestamp: new Date(),
    }

    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    throttledScrollToBottom()

    const response = await client.api.chat.$post(
      {
        json: {
          messages: newMessages.slice(1).map((x) => ({
            role: x.role,
            content: x.content,
          })),
        },
      },
      { init: { signal: abortController.signal } },
    )

    if (response.ok) {
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Failed to get reader from response body.')
      }

      const decoder = new TextDecoder('utf-8')
      let chunks = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks += decoder.decode(value, { stream: true })
          setStreaming((p) => ({ ...p, text: `${chunks}` }))
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: chunks,
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
    if (streaming.text === '') {
      // ストリーミング中に応答が返る前にキャンセルされた場合、メッセージは追加しない
      messages.pop()
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: streaming.text,
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

  // スクロール位置を監視して自動スクロールするかどうかを判定
  const handleScroll = () => {
    if (!scrollContainerRef.current) return

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    const isNearBottom = scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_THRESHOLD
    setShouldAutoScroll(isNearBottom)
  }

  // 現在のスクロール位置が一番下付近かどうかをチェック
  const isNearBottom = useCallback(() => {
    if (!scrollContainerRef.current) return false
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    return scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_THRESHOLD
  }, [])

  // スクロール処理をthrottleで間引く
  const throttledScrollToBottom = useCallback(() => {
    const now = Date.now()
    const timeSinceLastScroll = now - lastScrollTimeRef.current

    const executeScroll = () => {
      // shouldAutoScrollとリアルタイムチェックの両方を確認
      if (shouldAutoScroll && isNearBottom() && messagesEndRef.current) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
          lastScrollTimeRef.current = Date.now()
        })
      }
    }

    // 100ms以内の連続スクロールは間引く
    if (timeSinceLastScroll < 100) {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
      scrollTimeoutRef.current = window.setTimeout(executeScroll, 100)
    } else {
      executeScroll()
      lastScrollTimeRef.current = now
    }
  }, [shouldAutoScroll, isNearBottom])

  useEffect(() => {
    // メッセージが更新されたときに、一番下にいる場合のみスクロール
    throttledScrollToBottom()
  }, [messages, streaming.text, throttledScrollToBottom])

  // コンポーネントのアンマウント時にタイマーをクリア
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [])

  return {
    messages,
    messagesEndRef,
    scrollContainerRef,
    streaming,
    handleSendMessage,
    handleSendMessageCancel,
    handleScroll,
  }
}
