import { type Dispatch, type FormEvent, type SetStateAction, useCallback } from 'react'
import { uuidv7 } from 'uuidv7'
import type { SaveGeneratedFileRequest } from '#/client/features/chat/components/assistant-code-block'
import type { useChatForm } from '#/client/features/chat/hooks/use-chat-form'
import type { useStreamProcessor } from '#/client/features/chat/hooks/use-stream-processor'
import {
  createAssistantMessage,
  createConversationTitle,
  createImageGenerationAssistantMessage,
  resolveChatRequestSettings,
} from '#/client/features/chat/lib/chat-message-factory'
import {
  buildEditedHistory,
  buildEditedSendMessages,
  prepareApiMessages,
  summarizeImageContext,
} from '#/client/features/chat/lib/edit-message'
import { buildImageGenerationPrompt } from '#/client/features/chat/lib/image-generation'
import { unknownChatError } from '#/client/shared/lib/chat-error'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'
import type { Conversation, GeneratedCodeFile, Message } from '#/types'
import type { ChatError } from '#/types/chat-api'

interface ConversationState {
  conversationId: string | null
  messages: Message[]
  isSavingConversation: boolean
  setConversationId: Dispatch<SetStateAction<string | null>>
  setMessages: Dispatch<SetStateAction<Message[]>>
  setIsSavingConversation: Dispatch<SetStateAction<boolean>>
  setStreamMessageId: Dispatch<SetStateAction<string | null>>
  setGenerationError: Dispatch<SetStateAction<ChatError | null>>
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
    onSessionCompleted?: (conversation: Conversation) => Promise<void> | void
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
    setGenerationError,
    markSessionOwnedSnapshot,
  } = conversationState
  const { loading, stream, submitChatCompletion, submitImageGeneration } = streamProcessor
  const { canSaveGeneratedFile, currentConversation, onConversationChange, onSessionCompleted, onDeleteMessages } =
    callbacks

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (settings.imageGenerationMode) {
        void handleImageGenerationSubmit()
        return
      }
      const requestSettings = resolveChatRequestSettings(settings)
      setGenerationError(null)
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
        .then(async ({ result, error, responseTimeMs }) => {
          if (error) {
            setGenerationError(error)
            return
          }

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
            const completedConversation = {
              id: currentConversationId,
              title: createConversationTitle(params.draftUserMessage.content),
              messages: finalMessages,
            }
            if (settings.streamMode) {
              await onSessionCompleted?.(completedConversation)
            } else {
              await onConversationChange?.(completedConversation)
            }
          } finally {
            setIsSavingConversation(false)
          }
        })
        .catch(() => {
          setGenerationError(unknownChatError())
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
      onSessionCompleted,
      resetAfterSubmit,
      setConversationId,
      setIsSavingConversation,
      setMessages,
      setStreamMessageId,
      setGenerationError,
      settings,
      submitChatCompletion,
    ]
  )

  async function handleImageGenerationSubmit() {
    const prompt = buildImageGenerationPrompt(messages, formState.input, settings.includeImageGenerationHistory)
    if (!prompt || !submitImageGeneration) {
      return
    }

    const assistantMessageId = uuidv7()
    const currentConversationId = conversationId || uuidv7()
    const draftUserMessage: Message = {
      id: uuidv7(),
      role: 'user',
      content: prompt.currentPrompt,
      metadata: {
        model: '',
        imageGenerationMode: true,
        includeImageGenerationHistory: settings.includeImageGenerationHistory,
      },
    }
    const nextMessages = [...messages, draftUserMessage]
    const draftConversation = {
      id: currentConversationId,
      title: createConversationTitle(draftUserMessage.content),
      messages: nextMessages,
    }

    setGenerationError(null)
    markSessionOwnedSnapshot(draftConversation)
    setConversationId(currentConversationId)
    setMessages(nextMessages)
    setStreamMessageId(assistantMessageId)
    resetAfterSubmit()

    try {
      const { result, error, responseTimeMs } = await submitImageGeneration({
        header: {
          apiKey: settings.apiKey,
          baseURL: settings.baseURL,
        },
        prompt: prompt.prompt,
        conversationId: currentConversationId,
        assistantMessageId,
      })

      if (error || !result) {
        setGenerationError(error ?? unknownChatError())
        return
      }

      const assistantMessage = createImageGenerationAssistantMessage({
        assistantMessageId,
        result,
        responseTimeMs,
      })
      const finalMessages = [...nextMessages, assistantMessage]
      const completedConversation = {
        id: currentConversationId,
        title: createConversationTitle(draftUserMessage.content),
        messages: finalMessages,
      }
      markSessionOwnedSnapshot(completedConversation)
      setMessages(finalMessages)

      setIsSavingConversation(true)
      try {
        await onConversationChange?.(completedConversation)
      } finally {
        setIsSavingConversation(false)
      }
    } catch {
      setGenerationError(unknownChatError())
    } finally {
      setStreamMessageId(null)
    }
  }

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
          force: params.force,
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

      if (messages[index]?.role === 'user' && messages[index].metadata.imageGenerationMode === true) {
        return
      }

      const editedMessages = buildEditedHistory(messages, index, nextText)
      const editedUserMessage = editedMessages?.at(-1)
      if (!editedMessages || !editedUserMessage || editedUserMessage.role !== 'user') {
        return
      }

      const assistantMessageId = uuidv7()
      setGenerationError(null)
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
        const { result, error, responseTimeMs } = await submitChatCompletion({
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

        if (error) {
          setGenerationError(error)
          return
        }

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
          const completedConversation = {
            id: draftConversationId,
            title,
            messages: finalMessages,
          }
          if (settings.streamMode) {
            await onSessionCompleted?.(completedConversation)
          } else {
            await onConversationChange?.(completedConversation)
          }
        } finally {
          setIsSavingConversation(false)
        }
      } catch {
        setGenerationError(unknownChatError())
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
      onSessionCompleted,
      setConversationId,
      setIsSavingConversation,
      setMessages,
      setStreamMessageId,
      setGenerationError,
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
