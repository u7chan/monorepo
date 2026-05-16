import { type Dispatch, type FormEvent, type SetStateAction, useCallback } from 'react'
import { uuidv7 } from 'uuidv7'
import type { SaveGeneratedFileRequest } from '#/client/components/chat/assistant-code-block'
import {
  createAssistantMessage,
  createConversationTitle,
  resolveChatRequestSettings,
} from '#/client/components/chat/chat-message-factory'
import {
  buildEditedHistory,
  buildEditedSendMessages,
  prepareApiMessages,
  summarizeImageContext,
} from '#/client/components/chat/edit-message'
import type { useChatForm } from '#/client/components/chat/hooks/use-chat-form'
import type { useStreamProcessor } from '#/client/components/chat/hooks/use-stream-processor'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { Conversation, GeneratedCodeFile, Message } from '#/types'

interface ConversationState {
  conversationId: string | null
  messages: Message[]
  isSavingConversation: boolean
  setConversationId: Dispatch<SetStateAction<string | null>>
  setMessages: Dispatch<SetStateAction<Message[]>>
  setIsSavingConversation: Dispatch<SetStateAction<boolean>>
  setStreamMessageId: Dispatch<SetStateAction<string | null>>
  markSessionOwnedSnapshot: (conversation: Pick<Conversation, 'id' | 'messages'>) => void
}

interface UseChatActionsParams {
  settings: Settings
  formState: ReturnType<typeof useChatForm>
  conversationState: ConversationState
  streamProcessor: ReturnType<typeof useStreamProcessor>
  callbacks: {
    canSaveGeneratedFile?: boolean
    currentConversation?: Conversation | null
    onConversationChange?: (conversation: Conversation) => Promise<void> | void
    onDeleteMessages?: (messageIds: string[], isConversationEmpty: boolean) => void
  }
}

export function useChatActions({
  settings,
  formState,
  conversationState,
  streamProcessor,
  callbacks,
}: UseChatActionsParams) {
  const { buildChatMessages, resetAfterSubmit } = formState
  const {
    conversationId,
    messages,
    isSavingConversation,
    setConversationId,
    setMessages,
    setIsSavingConversation,
    setStreamMessageId,
    markSessionOwnedSnapshot,
  } = conversationState
  const { loading, stream, submitChatCompletion } = streamProcessor
  const { canSaveGeneratedFile, currentConversation, onConversationChange, onDeleteMessages } = callbacks

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const requestSettings = resolveChatRequestSettings(settings)
      const params = buildChatMessages({
        apiMode: settings.apiMode,
        includeChatHistory: settings.includeChatHistory,
        messages,
        model: requestSettings.model,
        streamMode: settings.streamMode,
        sendImagesOnlyOnce: settings.sendImagesOnlyOnce,
        temperature: requestSettings.temperature,
        maxTokens: requestSettings.maxTokens,
        reasoningEffort: requestSettings.reasoningEffort,
      })
      if (!params) {
        return
      }

      const nextMessages: Message[] =
        messages.length === 0
          ? [...(params.systemMessage ? [params.systemMessage] : []), params.draftUserMessage]
          : [...messages, params.draftUserMessage]
      const assistantMessageId = uuidv7()
      const currentConversationId = conversationId || uuidv7()
      const draftConversation = {
        id: currentConversationId,
        title: createConversationTitle(params.draftUserMessage.content),
        messages: nextMessages,
      }
      markSessionOwnedSnapshot(draftConversation)
      setConversationId(currentConversationId)
      setMessages(nextMessages)
      setStreamMessageId(assistantMessageId)
      resetAfterSubmit()

      submitChatCompletion({
        header: {
          apiKey: requestSettings.apiKey,
          baseURL: requestSettings.baseURL,
        },
        apiMode: settings.apiMode,
        model: params.model,
        messages: params.apiMessages,
        streamMode: settings.streamMode,
        conversation: draftConversation,
        assistantMessageId,
        temperature: requestSettings.temperature,
        maxTokens: requestSettings.maxTokens,
        reasoningEffort: requestSettings.reasoningEffort,
      })
        .then(async ({ result, responseTimeMs }) => {
          const assistantMessage = result
            ? createAssistantMessage({
                assistantMessageId,
                result,
                apiMode: settings.apiMode,
                responseTimeMs,
                imageContext: params.imageContext,
                apiContextMessages: params.apiMessages,
              })
            : null

          const finalMessages: Message[] = assistantMessage ? [...nextMessages, assistantMessage] : nextMessages
          markSessionOwnedSnapshot({
            id: currentConversationId,
            messages: finalMessages,
          })
          setMessages(finalMessages)

          setIsSavingConversation(true)
          try {
            await onConversationChange?.({
              id: currentConversationId,
              title: createConversationTitle(params.draftUserMessage.content),
              messages: finalMessages,
            })
          } finally {
            setIsSavingConversation(false)
          }
        })
        .finally(() => {
          setStreamMessageId(null)
        })
    },
    [
      buildChatMessages,
      conversationId,
      markSessionOwnedSnapshot,
      messages,
      onConversationChange,
      resetAfterSubmit,
      setConversationId,
      setIsSavingConversation,
      setMessages,
      setStreamMessageId,
      settings,
      submitChatCompletion,
    ]
  )

  const handleSaveGeneratedFile = useCallback(
    async (messageIndex: number, params: SaveGeneratedFileRequest): Promise<GeneratedCodeFile | null> => {
      if (!canSaveGeneratedFile) {
        return null
      }

      const target = messages[messageIndex]
      if (!target || target.role !== 'assistant' || !target.id || !conversationId) {
        return null
      }

      const res = await fetch('/api/conversations/messages/generated-files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          messageId: target.id,
          blockIndex: params.blockIndex,
          language: params.language,
          content: params.content,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? `Request failed: ${res.status}`)
      }
      const payload = (await res.json()) as { file: GeneratedCodeFile; alreadyExisted?: boolean }

      setMessages((prev) =>
        prev.map((msg, idx) => {
          if (idx !== messageIndex || msg.role !== 'assistant') {
            return msg
          }
          const existingFiles = msg.metadata.generatedFiles ?? []
          const withoutSame = existingFiles.filter((f) => f.blockIndex !== payload.file.blockIndex)
          return {
            ...msg,
            metadata: {
              ...msg.metadata,
              generatedFiles: [...withoutSame, payload.file],
            },
          }
        })
      )
      return payload.file
    },
    [canSaveGeneratedFile, conversationId, messages, setMessages]
  )

  const handleEditMessage = useCallback(
    async (index: number, nextText: string): Promise<void> => {
      if (loading || stream || isSavingConversation) {
        return
      }

      const editedMessages = buildEditedHistory(messages, index, nextText)
      const editedUserMessage = editedMessages?.at(-1)
      if (!editedMessages || !editedUserMessage || editedUserMessage.role !== 'user') {
        return
      }

      const assistantMessageId = uuidv7()
      const sendMessages = buildEditedSendMessages(editedMessages, editedUserMessage.id, settings.includeChatHistory)
      const apiMessages = prepareApiMessages(sendMessages, editedUserMessage.id, settings.sendImagesOnlyOnce)
      const imageContext = summarizeImageContext(sendMessages, editedUserMessage.id, settings.sendImagesOnlyOnce)
      const requestSettings = resolveChatRequestSettings(settings)
      const draftConversationId = conversationId || uuidv7()
      const title = currentConversation?.title ?? createConversationTitle(nextText.trim())
      const draftConversation = {
        id: draftConversationId,
        title,
        messages: editedMessages,
      }
      markSessionOwnedSnapshot(draftConversation)
      setConversationId(draftConversationId)
      setMessages(editedMessages)
      setStreamMessageId(assistantMessageId)

      try {
        const { result, responseTimeMs } = await submitChatCompletion({
          header: {
            apiKey: requestSettings.apiKey,
            baseURL: requestSettings.baseURL,
          },
          apiMode: settings.apiMode,
          model: requestSettings.model,
          messages: apiMessages,
          streamMode: settings.streamMode,
          conversation: draftConversation,
          assistantMessageId,
          temperature: requestSettings.temperature,
          maxTokens: requestSettings.maxTokens,
          reasoningEffort: requestSettings.reasoningEffort,
        })

        const assistantMessage = result
          ? createAssistantMessage({
              assistantMessageId,
              result,
              apiMode: settings.apiMode,
              responseTimeMs,
              imageContext,
              apiContextMessages: apiMessages,
            })
          : null

        const finalMessages = assistantMessage ? [...editedMessages, assistantMessage] : editedMessages
        markSessionOwnedSnapshot({
          id: draftConversationId,
          messages: finalMessages,
        })
        setMessages(finalMessages)

        setIsSavingConversation(true)
        try {
          await onConversationChange?.({
            id: draftConversationId,
            title,
            messages: finalMessages,
          })
        } finally {
          setIsSavingConversation(false)
        }
      } finally {
        setStreamMessageId(null)
      }
    },
    [
      conversationId,
      currentConversation?.title,
      isSavingConversation,
      loading,
      markSessionOwnedSnapshot,
      messages,
      onConversationChange,
      setConversationId,
      setIsSavingConversation,
      setMessages,
      setStreamMessageId,
      settings,
      stream,
      submitChatCompletion,
    ]
  )

  const handleClickDeleteMessage = useCallback(
    (index: number) => {
      if (confirm('本当に削除しますか？')) {
        let isConversationEmpty = false
        setMessages((prevMessages) => {
          const newMessages = [...prevMessages]
          newMessages.splice(index, 1)
          newMessages.splice(index, 1)
          isConversationEmpty = newMessages.filter((m) => m.role !== 'system').length <= 0
          return newMessages
        })
        const deleteMessageIds = [
          currentConversation?.messages?.at(index)?.id,
          currentConversation?.messages?.at(index + 1)?.id,
        ].filter((value): value is string => value !== undefined)
        onDeleteMessages?.(deleteMessageIds, isConversationEmpty)
      }
    },
    [currentConversation?.messages, onDeleteMessages, setMessages]
  )

  return {
    handleSubmit,
    handleSaveGeneratedFile,
    handleEditMessage,
    handleClickDeleteMessage,
  }
}
