import { ChatInput } from '#/client/components/chat/chat-input'
import { ChatMessageList } from '#/client/components/chat/chat-message-list'
import { useChatForm } from '#/client/components/chat/hooks/use-chat-form'
import { useMessageCopy } from '#/client/components/chat/hooks/use-message-copy'
import { useMessageScroll } from '#/client/components/chat/hooks/use-message-scroll'
import { useStreamProcessor } from '#/client/components/chat/hooks/use-stream-processor'
import { PromptTemplate, type TemplateInput } from '#/client/components/chat/prompt-template'
import { FileImageInput, FileImagePreview } from '#/client/components/input/file-image-input'
import { ArrowUpIcon } from '#/client/components/svg/arrow-upIcon'
import { StopIcon } from '#/client/components/svg/stop-icon'
import { UploadIcon } from '#/client/components/svg/upload-icon'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { Conversation, Message } from '#/types'
import React, { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uuidv7 } from 'uuidv7'

interface Props {
  initTrigger?: number
  settings: Settings
  currentConversation?: Conversation | null
  onSubmitting?: (submitting: boolean) => void
  onConversationChange?: (conversation: Conversation) => void
  onDeleteMessages?: (messageIds: string[], isConversationEmpty: boolean) => void
}

export function ChatMain({
  initTrigger,
  settings,
  currentConversation,
  onSubmitting,
  onConversationChange,
  onDeleteMessages,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null)

  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const {
    input,
    uploadImages,
    textAreaRows,
    setTemplateInput,
    handleUploadImageChange,
    handleChangeInput,
    handleKeyDown,
    handleChangeComposition,
    buildChatMessages,
    resetAfterSubmit,
  } = useChatForm({ initTrigger, formRef })
  const { copiedId, copyMessage } = useMessageCopy()
  const { loading, stream, chatResults, cancelStream, resetChatResults, submitChatCompletion } = useStreamProcessor({
    onSubmitting,
  })
  const { scrollContainerRef, bottomChatInputContainerRef, messageEndRef, handleScroll, scrollToMessageEnd } =
    useMessageScroll({
      loading,
      streamMode: settings.streamMode,
      stream,
      chatResults,
    })

  useEffect(() => {
    setMessages([])
    setConversationId(null)
    resetChatResults()
  }, [initTrigger])

  // 選択された会話のメッセージを設定
  useEffect(() => {
    if (!currentConversation) {
      return
    }

    // 会話が選択された時、そのメッセージをドメイン型のまま設定（変換不要）
    setConversationId(currentConversation.id)
    setMessages(currentConversation.messages)
    resetChatResults()
    setTimeout(() => {
      scrollToMessageEnd()
    }, 0)
  }, [currentConversation, resetChatResults, scrollToMessageEnd])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const formData = new FormData(event.currentTarget)
      const form = {
        model: settings.fakeMode ? 'fakemode' : settings.model,
        baseURL: settings.fakeMode ? 'fakemode' : settings.baseURL,
        apiKey: settings.fakeMode ? 'fakemode' : settings.apiKey,
        mcpServerURLs: settings.fakeMode ? '' : settings.mcpServerURLs,
        temperature: settings.temperatureEnabled ? settings.temperature : undefined,
        maxTokens: settings.maxTokens ? Number(settings.maxTokens) : undefined,
        userInput: formData.get('userInput')?.toString() || '',
      }
      const params = buildChatMessages({
        interactiveMode: settings.interactiveMode,
        messages,
        model: form.model,
      })
      if (!params) {
        return
      }

      // 送信直後に user メッセージを state に追加（ドメイン型で保持）
      const nextMessages: Message[] = messages.length === 0 ? [params.draftUserMessage] : [...messages, params.draftUserMessage]
      setMessages(nextMessages)
      resetAfterSubmit()
      resetChatResults()

      submitChatCompletion({
        header: {
          apiKey: form.apiKey,
          baseURL: form.baseURL,
          mcpServerURLs: form.mcpServerURLs,
        },
        model: params.model,
        messages: params.apiMessages,
        streamMode: settings.streamMode,
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        reasoningEffort: settings.reasoningEffortEnabled ? settings.reasoningEffort : undefined,
      }).then(({ result, responseTimeMs }) => {
        const userContent = params.draftUserMessage.content

        // assistant メッセージを state に追加（ドメイン型で保持）
        const assistantMessage: Message | null = result
          ? {
              role: 'assistant' as const,
              content: result.message.content,
              reasoningContent: result.message.reasoningContent,
              metadata: {
                model: result.model,
                finishReason: result.finishReason,
                responseTimeMs: responseTimeMs,
                usage: {
                  promptTokens: result.usage?.promptTokens || 0,
                  completionTokens: result.usage?.completionTokens || 0,
                  totalTokens: result.usage?.totalTokens || 0,
                  reasoningTokens: result.usage?.reasoningTokens,
                },
              },
            }
          : null

        const finalMessages: Message[] = assistantMessage ? [...nextMessages, assistantMessage] : nextMessages
        setMessages(finalMessages)

        // 会話IDが指定されていない場合は会話IDを新規作成
        const currentConversationId =
          conversationId ||
          (() => {
            const newConversationId = uuidv7()
            setConversationId(newConversationId)
            return newConversationId
          })()

        // 親コンポーネントに更新されたメッセージを通知（ドメイン型をそのまま渡す）
        onConversationChange?.({
          id: currentConversationId,
          title: typeof userContent === 'string' ? userContent.slice(0, 10) : '',
          messages: finalMessages,
        })
      })
    },
    [
      buildChatMessages,
      conversationId,
      messages,
      onConversationChange,
      resetAfterSubmit,
      resetChatResults,
      settings.apiKey,
      settings.baseURL,
      settings.fakeMode,
      settings.interactiveMode,
      settings.maxTokens,
      settings.mcpServerURLs,
      settings.model,
      settings.reasoningEffort,
      settings.reasoningEffortEnabled,
      settings.streamMode,
      settings.temperature,
      settings.temperatureEnabled,
      submitChatCompletion,
    ]
  )

  const handleTemplateSubmit = useCallback(
    (templateInput: TemplateInput) => {
      setTemplateInput(templateInput)
      formRef.current?.requestSubmit()
    },
    [setTemplateInput]
  )

  const handleClickDeleteMessage = useCallback(
    (index: number) => {
      if (confirm('本当に削除しますか？')) {
        let isConversationEmpty = false
        setMessages((prevMessages) => {
          const newMessages = [...prevMessages]
          newMessages.splice(index, 1)
          newMessages.splice(index, 1)
          isConversationEmpty = newMessages.length <= 0
          return newMessages
        })
        const deleteMessageIds = [
          currentConversation?.messages?.at(index)?.id,
          currentConversation?.messages?.at(index + 1)?.id,
        ].filter((value): value is string => value !== undefined)
        onDeleteMessages?.(deleteMessageIds, isConversationEmpty)
      }
    },
    [currentConversation?.messages, onDeleteMessages]
  )

  const emptyMessage = messages.length === 0

  return (
    <form ref={formRef} onSubmit={handleSubmit} className='flex h-full min-h-0 flex-1 flex-col'>
      {emptyMessage && (
        <div className='flex min-h-0 flex-1 items-center justify-center'>
          <div className='container mx-auto flex max-w-(--breakpoint-lg) flex-1 items-center justify-center'>
            <div className='flex w-full flex-col justify-center gap-3'>
              <div
                className={
                  'mb-2 text-center font-bold text-2xl text-gray-700 hidden md:block sm:text-3xl dark:text-gray-200'
                }
              >
                お手伝いできることはありますか？
              </div>
              <div className='hidden md:block'>
                <PromptTemplate placeholder={settings.model} onSubmit={handleTemplateSubmit} />
              </div>
              <ChatInput
                name='userInput'
                value={input}
                textAreaRows={textAreaRows}
                placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
                disabled={loading}
                rightBottom={
                  <SendButton
                    color={settings.interactiveMode ? 'primary' : 'green'}
                    loading={loading}
                    disabled={loading || !!stream || input.trim().length <= 0}
                    handleClickStop={cancelStream}
                  />
                }
                leftBottom={
                  <FileImagePreview src={uploadImages} onImageChange={handleUploadImageChange}>
                    <FileImageInput
                      fileInputButton={(onClick) => (
                        <button
                          type='button'
                          onClick={onClick}
                          disabled={loading || !!stream}
                          className='group flex cursor-pointer items-center gap-0.5 rounded-3xl border border-gray-200 bg-white px-2 py-1 transition-colors hover:bg-gray-100 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-50 disabled:hover:cursor-default disabled:hover:bg-white dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:disabled:hover:bg-gray-700'
                        >
                          <UploadIcon size={20} className='fill-gray-500 group-disabled:fill-gray-300' />
                          <div className='hidden sm:block mr-0.5 text-gray-500 text-xs group-disabled:text-gray-300 dark:text-gray-400 dark:group-disabled:text-gray-500'>
                            画像アップロード
                          </div>
                        </button>
                      )}
                      onImageChange={handleUploadImageChange}
                    />
                  </FileImagePreview>
                }
                onChangeInput={handleChangeInput}
                onKeyDown={handleKeyDown}
                onChangeComposition={handleChangeComposition}
              />
              <div className='py-4' />
            </div>
          </div>
        </div>
      )}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={emptyMessage ? 'hidden' : 'min-h-0 flex-1 overflow-y-auto'}
      >
        {!emptyMessage && (
          <ChatMessageList
            messages={messages}
            markdownPreview={settings.markdownPreview}
            loading={loading}
            stream={stream}
            chatResults={chatResults}
            copiedId={copiedId}
            messageEndRef={messageEndRef}
            onCopyMessage={copyMessage}
            onDeleteMessage={handleClickDeleteMessage}
          />
        )}
      </div>

      <div ref={bottomChatInputContainerRef} className='container mx-auto max-w-(--breakpoint-lg)'>
        {!emptyMessage && (
          <>
            <ChatInput
              name='userInput'
              value={input}
              textAreaRows={textAreaRows}
              placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
              disabled={loading}
              rightBottom={
                <SendButton
                  color={settings.interactiveMode ? 'primary' : 'green'}
                  loading={loading}
                  disabled={loading || !!stream || input.trim().length <= 0}
                  handleClickStop={cancelStream}
                />
              }
              leftBottom={
                <FileImagePreview src={uploadImages} onImageChange={handleUploadImageChange}>
                  <FileImageInput
                    fileInputButton={(onClick) => (
                      <button
                        type='button'
                        onClick={onClick}
                        disabled={loading || !!stream}
                        className='group flex cursor-pointer items-center gap-0.5 rounded-3xl border border-gray-200 bg-white px-2 py-1 transition-colors hover:bg-gray-100 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-50 disabled:hover:cursor-default disabled:hover:bg-white'
                      >
                        <UploadIcon size={20} className='fill-gray-500 group-disabled:fill-gray-300' />
                        <div className='hidden sm:block mr-0.5 text-gray-500 text-xs group-disabled:text-gray-300'>
                          画像アップロード
                        </div>
                      </button>
                    )}
                    onImageChange={handleUploadImageChange}
                  />
                </FileImagePreview>
              }
              onChangeInput={handleChangeInput}
              onKeyDown={handleKeyDown}
              onChangeComposition={handleChangeComposition}
            />
            <div className='h-4' />
          </>
        )}
      </div>
    </form>
  )
}

interface SendButtonProps {
  color?: 'primary' | 'blue' | 'green'
  loading?: boolean
  disabled?: boolean
  handleClickStop?: () => void
}

function SendButton({ color = 'blue', loading, disabled, handleClickStop }: SendButtonProps) {
  const classes = useMemo(() => {
    switch (color) {
      case 'primary':
        return 'bg-primary-800 hover:bg-primary-700 disabled:hover:bg-primary-800'
      case 'blue':
        return 'bg-blue-400 hover:bg-blue-300 disabled:hover:bg-blue-400'
      case 'green':
        return 'bg-emerald-400 hover:bg-emerald-300 disabled:hover:bg-emerald-400'
      default:
        throw new Error(`Invalid color type: ${color}`)
    }
  }, [color])
  return (
    <>
      {loading ? (
        <button
          type='button'
          onClick={handleClickStop}
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700`}
        >
          <StopIcon className='fill-white' size={18} />
        </button>
      ) : (
        <button
          type='submit'
          disabled={disabled}
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700`}
        >
          <ArrowUpIcon className='fill-white' size={22} />
        </button>
      )}
    </>
  )
}
