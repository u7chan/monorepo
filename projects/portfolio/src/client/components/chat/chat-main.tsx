import { ChatComposer } from '#/client/components/chat/chat-composer'
import { ChatMessageList } from '#/client/components/chat/chat-message-list'
import { useChatActions } from '#/client/components/chat/hooks/use-chat-actions'
import { useChatConversation } from '#/client/components/chat/hooks/use-chat-conversation'
import { useChatForm } from '#/client/components/chat/hooks/use-chat-form'
import { useMessageCopy } from '#/client/components/chat/hooks/use-message-copy'
import { useMessageScroll } from '#/client/components/chat/hooks/use-message-scroll'
import { PromptTemplate, type TemplateInput } from '#/client/components/chat/prompt-template'
import { ArrowDownIcon } from '#/client/components/svg/arrow-down-icon'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { Conversation } from '#/types'
import { useCallback, useEffect, useRef } from 'react'

interface Props {
  initTrigger?: number
  settings: Settings
  currentConversation?: Conversation | null
  canSaveGeneratedFile?: boolean
  onSubmitting?: (submitting: boolean) => void
  onConversationChange?: (conversation: Conversation) => Promise<void> | void
  onDeleteMessages?: (messageIds: string[], isConversationEmpty: boolean) => void
}

export function ChatMain({
  initTrigger,
  settings,
  currentConversation,
  canSaveGeneratedFile,
  onSubmitting,
  onConversationChange,
  onDeleteMessages,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null)
  const prevConversationIdRef = useRef<string | null>(null)
  const conversationState = useChatConversation({
    initTrigger,
    settings,
    currentConversation,
    onSubmitting,
    onConversationChange,
  })
  const { conversationId, messages, isSavingConversation, streamMessageId, streamProcessor } = conversationState
  const { loading, stream, cancelStream } = streamProcessor
  const formState = useChatForm({ initTrigger, formRef, submitDisabled: loading || !!stream })
  const {
    input,
    uploadImages,
    textAreaRows,
    setTemplateInput,
    handleUploadImageChange,
    handleChangeInput,
    handleKeyDown,
    handleChangeComposition,
  } = formState
  const { copiedId, copyMessage } = useMessageCopy()
  const {
    scrollContainerRef,
    bottomChatInputContainerRef,
    messageEndRef,
    isPinnedToBottom,
    handleScroll,
    scrollToMessageEnd,
  } = useMessageScroll({
    loading,
    streamMode: settings.streamMode,
    stream,
    messages,
  })
  const { handleSubmit, handleSaveGeneratedFile, handleEditMessage, handleClickDeleteMessage } = useChatActions({
    settings,
    formState,
    conversationState,
    streamProcessor,
    callbacks: {
      canSaveGeneratedFile,
      currentConversation,
      onConversationChange,
      onDeleteMessages,
    },
  })

  useEffect(() => {
    if (!currentConversation || prevConversationIdRef.current === currentConversation.id) {
      return
    }

    prevConversationIdRef.current = currentConversation.id
    setTimeout(() => {
      scrollToMessageEnd()
    }, 0)
  }, [currentConversation, scrollToMessageEnd])

  const handleTemplateSubmit = useCallback(
    (templateInput: TemplateInput) => {
      setTemplateInput(templateInput)
      formRef.current?.requestSubmit()
    },
    [setTemplateInput]
  )

  const emptyMessage = messages.filter((m) => m.role !== 'system').length === 0

  return (
    <form ref={formRef} onSubmit={handleSubmit} className='flex min-h-0 flex-1 flex-col'>
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
                <PromptTemplate
                  autoModel={settings.autoModel}
                  placeholder={settings.model}
                  onSubmit={handleTemplateSubmit}
                />
              </div>
              <ChatComposer
                value={input}
                textAreaRows={textAreaRows}
                placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
                disabled={loading}
                loading={loading}
                streamActive={!!stream}
                includeChatHistory={settings.includeChatHistory}
                sendImagesOnlyOnce={settings.sendImagesOnlyOnce}
                uploadImages={uploadImages}
                onCancelStream={cancelStream}
                onImageChange={handleUploadImageChange}
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
        className={emptyMessage ? 'hidden' : 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden'}
      >
        {!emptyMessage && (
          <ChatMessageList
            messages={messages}
            conversationId={conversationId}
            canSaveGeneratedFile={canSaveGeneratedFile}
            markdownPreview={settings.markdownPreview}
            sendImagesOnlyOnce={settings.sendImagesOnlyOnce}
            loading={loading}
            stream={stream}
            streamMessageId={streamMessageId}
            copiedId={copiedId}
            savingConversation={isSavingConversation}
            messageEndRef={messageEndRef}
            onCopyMessage={copyMessage}
            onDeleteMessage={handleClickDeleteMessage}
            onEditMessage={handleEditMessage}
            onSaveGeneratedFile={handleSaveGeneratedFile}
          />
        )}
      </div>

      <div
        ref={bottomChatInputContainerRef}
        className='relative z-10 shrink-0 container mx-auto max-w-(--breakpoint-lg)'
      >
        {!emptyMessage && (
          <>
            <div
              className={`absolute inset-x-0 -top-11 flex justify-center px-4 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
                isPinnedToBottom ? 'pointer-events-none opacity-0' : 'pointer-events-none opacity-100'
              }`}
            >
              <button
                type='button'
                aria-label='最下部へ移動'
                aria-hidden={isPinnedToBottom}
                tabIndex={isPinnedToBottom ? -1 : 0}
                disabled={isPinnedToBottom}
                onClick={() => scrollToMessageEnd('smooth')}
                className='pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-700 shadow-sm transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:border-gray-600 dark:bg-gray-800/95 dark:text-gray-100 dark:hover:bg-gray-700 dark:focus-visible:ring-gray-500'
              >
                <ArrowDownIcon size={14} className='stroke-current' />
              </button>
            </div>
            <ChatComposer
              value={input}
              textAreaRows={textAreaRows}
              placeholder='質問してみよう！'
              loading={loading}
              streamActive={!!stream}
              includeChatHistory={settings.includeChatHistory}
              sendImagesOnlyOnce={settings.sendImagesOnlyOnce}
              uploadImages={uploadImages}
              onCancelStream={cancelStream}
              onImageChange={handleUploadImageChange}
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
