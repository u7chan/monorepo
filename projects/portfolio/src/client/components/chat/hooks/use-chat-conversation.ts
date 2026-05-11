import { createAssistantMessage } from '#/client/components/chat/chat-message-factory'
import { hasActiveChatSession, useStreamProcessor } from '#/client/components/chat/hooks/use-stream-processor'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { Conversation, Message } from '#/types'
import type { ChatResponse } from '#/types/chat-api'
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseChatConversationParams {
  initTrigger?: number
  settings: Settings
  currentConversation?: Conversation | null
  onSubmitting?: (submitting: boolean) => void
  onConversationChange?: (conversation: Conversation) => Promise<void> | void
}

export function useChatConversation({
  initTrigger,
  settings,
  currentConversation,
  onSubmitting,
  onConversationChange,
}: UseChatConversationParams) {
  const sessionOwnedSnapshotRef = useRef<{ conversationId: string; messageIds: string[] } | null>(null)
  const resumeStartedRef = useRef(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isSavingConversation, setIsSavingConversation] = useState(false)
  const [streamMessageId, setStreamMessageId] = useState<string | null>(null)

  const markSessionOwnedSnapshot = useCallback((conversation: Pick<Conversation, 'id' | 'messages'>) => {
    sessionOwnedSnapshotRef.current = {
      conversationId: conversation.id,
      messageIds: conversation.messages.map(({ id }) => id).filter((id): id is string => !!id),
    }
  }, [])

  const commitConversationMessages = useCallback(
    (nextConversationId: string, nextMessages: Message[], nextStreamMessageId: string | null) => {
      setConversationId(nextConversationId)
      setMessages(nextMessages)
      setStreamMessageId(nextStreamMessageId)
    },
    []
  )

  const handleSessionConversation = useCallback(
    (conversation: Conversation, assistantMessageId: string) => {
      markSessionOwnedSnapshot(conversation)
      commitConversationMessages(conversation.id, conversation.messages, assistantMessageId)
    },
    [commitConversationMessages, markSessionOwnedSnapshot]
  )

  const handleSessionResult = useCallback(
    ({
      conversation,
      assistantMessageId,
      result,
    }: {
      conversation: Conversation
      assistantMessageId: string
      result: ChatResponse | null
    }) => {
      if (!result) return

      const assistantMessage = createAssistantMessage({
        assistantMessageId,
        result,
        apiMode: settings.apiMode,
        responseTimeMs: 0,
      })
      const finalMessages = [...conversation.messages, assistantMessage]
      markSessionOwnedSnapshot({
        id: conversation.id,
        messages: finalMessages,
      })
      commitConversationMessages(conversation.id, finalMessages, null)
    },
    [commitConversationMessages, markSessionOwnedSnapshot, settings.apiMode]
  )

  const streamProcessor = useStreamProcessor({
    onSubmitting,
    onSessionConversation: handleSessionConversation,
    onSessionResult: handleSessionResult,
  })
  const { resumeActiveChatCompletion } = streamProcessor

  useEffect(() => {
    sessionOwnedSnapshotRef.current = null
    setMessages([])
    setConversationId(null)
    setStreamMessageId(null)
  }, [initTrigger])

  useEffect(() => {
    if (resumeStartedRef.current || !hasActiveChatSession()) {
      return
    }

    resumeStartedRef.current = true
    let mounted = true
    void resumeActiveChatCompletion().then(async (resumed) => {
      if (!mounted || !resumed?.conversation) return

      const assistantMessage = resumed.result
        ? createAssistantMessage({
            assistantMessageId: resumed.assistantMessageId,
            result: resumed.result,
            apiMode: settings.apiMode,
            responseTimeMs: resumed.responseTimeMs,
          })
        : null
      const finalMessages = assistantMessage
        ? [...resumed.conversation.messages, assistantMessage]
        : resumed.conversation.messages

      markSessionOwnedSnapshot({
        id: resumed.conversation.id,
        messages: finalMessages,
      })
      commitConversationMessages(resumed.conversation.id, finalMessages, null)

      if (assistantMessage) {
        await onConversationChange?.({
          ...resumed.conversation,
          messages: finalMessages,
        })
      }
    })

    return () => {
      mounted = false
    }
  }, [
    commitConversationMessages,
    markSessionOwnedSnapshot,
    onConversationChange,
    resumeActiveChatCompletion,
    settings.apiMode,
  ])

  useEffect(() => {
    if (!currentConversation) {
      return
    }

    const sessionOwnedSnapshot = sessionOwnedSnapshotRef.current
    if (sessionOwnedSnapshot) {
      if (currentConversation.id === sessionOwnedSnapshot.conversationId) {
        const currentMessageIds = new Set(currentConversation.messages.map(({ id }) => id).filter(Boolean))
        const hasCaughtUp = sessionOwnedSnapshot.messageIds.every((id) => currentMessageIds.has(id))
        if (!hasCaughtUp) {
          return
        }
      }
      sessionOwnedSnapshotRef.current = null
    }

    commitConversationMessages(currentConversation.id, currentConversation.messages, null)
  }, [commitConversationMessages, currentConversation])

  return {
    conversationId,
    messages,
    isSavingConversation,
    streamMessageId,
    setConversationId,
    setMessages,
    setIsSavingConversation,
    setStreamMessageId,
    markSessionOwnedSnapshot,
    streamProcessor,
  }
}
