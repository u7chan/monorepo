import { type ChangeEvent, type KeyboardEvent, type RefObject, useEffect, useState } from 'react'
import { uuidv7 } from 'uuidv7'
import type { TemplateInput } from '#/client/features/chat/components/prompt-template'
import { prepareApiMessages, summarizeImageContext } from '#/client/features/chat/lib/edit-message'
import type { ApiChatMessage, ApiMode, ImageContextSummary, Message, ReasoningEffort } from '#/types'

const MIN_TEXT_LINE_COUNT = 2
const MAX_TEXT_LINE_COUNT = 5

interface UseChatFormParams {
  initTrigger?: number
  formRef: RefObject<HTMLFormElement | null>
  submitDisabled?: boolean
}

interface BuildChatMessagesParams {
  apiMode: ApiMode
  includeChatHistory: boolean
  messages: Message[]
  model: string
  streamMode: boolean
  sendImagesOnlyOnce: boolean
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
}

interface BuiltChatMessages {
  model: string
  /** /api/chat wire 形式（metadata・reasoningContent を除いた送信用メッセージ） */
  apiMessages: ApiChatMessage[]
  /** 送信に使ったドメインメッセージ（state 更新用） */
  draftUserMessage: Message
  /** テンプレート送信時の system message（state 保持用）。通常送信時は undefined */
  systemMessage?: Message
  imageContext: ImageContextSummary
}

export function useChatForm({ initTrigger, formRef, submitDisabled = false }: UseChatFormParams) {
  const [input, setInput] = useState('')
  const [templateInput, setTemplateInput] = useState<TemplateInput | null>(null)
  const [uploadImages, setUploadImages] = useState<string[]>([])
  const [textAreaRows, setTextAreaRows] = useState(MIN_TEXT_LINE_COUNT)
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    setInput('')
    setTemplateInput(null)
    setUploadImages([])
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
    setComposing(false)
  }, [initTrigger])

  const handleUploadImageChange = (src: string, index?: number) => {
    if (!src && index !== undefined) {
      if (uploadImages.length === 1) {
        setUploadImages([])
      } else {
        setUploadImages((previous) => previous.filter((_, currentIndex) => currentIndex !== index))
      }
    } else {
      setUploadImages([...uploadImages, src])
    }
  }

  const handleChangeInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    const lineCount = (value.match(/\n/g) || []).length + 1

    if (lineCount <= MIN_TEXT_LINE_COUNT) {
      setTextAreaRows(MIN_TEXT_LINE_COUNT)
    } else if (lineCount >= MAX_TEXT_LINE_COUNT) {
      setTextAreaRows(MAX_TEXT_LINE_COUNT)
    } else {
      setTextAreaRows(lineCount)
    }

    setInput(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value.trim()
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      if (!submitDisabled && content && formRef.current) {
        formRef.current.requestSubmit()
      }
    }
  }

  const buildChatMessages = ({
    apiMode,
    includeChatHistory,
    messages,
    model,
    streamMode,
    sendImagesOnlyOnce,
    temperature,
    maxTokens,
    reasoningEffort,
  }: BuildChatMessagesParams): BuiltChatMessages | null => {
    if (templateInput) {
      return createTemplateMessage(templateInput, model, {
        apiMode,
        includeChatHistory,
        messages,
        streamMode,
        sendImagesOnlyOnce,
        temperature,
        maxTokens,
        reasoningEffort,
      })
    }

    return createMessage(input.trim(), model, {
      apiMode,
      includeChatHistory,
      messages,
      uploadImages,
      streamMode,
      sendImagesOnlyOnce,
      temperature,
      maxTokens,
      reasoningEffort,
    })
  }

  const resetAfterSubmit = () => {
    setInput('')
    setTemplateInput(null)
    setUploadImages([])
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
  }

  return {
    input,
    templateInput,
    uploadImages,
    textAreaRows,
    setTemplateInput,
    handleUploadImageChange,
    handleChangeInput,
    handleKeyDown,
    handleChangeComposition: setComposing,
    buildChatMessages,
    resetAfterSubmit,
  }
}

const createMessage = (
  inputText: string,
  model: string,
  {
    apiMode,
    includeChatHistory,
    messages,
    uploadImages,
    streamMode,
    sendImagesOnlyOnce,
    temperature,
    maxTokens,
    reasoningEffort,
  }: {
    apiMode: ApiMode
    includeChatHistory: boolean
    messages: Message[]
    uploadImages: string[]
    streamMode: boolean
    sendImagesOnlyOnce: boolean
    temperature?: number
    maxTokens?: number
    reasoningEffort?: ReasoningEffort
  }
): BuiltChatMessages | null => {
  if (!inputText) {
    return null
  }

  const draftUserMessage: Message = {
    id: uuidv7(),
    role: 'user',
    content:
      uploadImages.length > 0
        ? [
            {
              type: 'text' as const,
              text: inputText,
            },
            ...uploadImages.map((image) => ({
              type: 'image_url' as const,
              image_url: {
                url: image,
              },
            })),
          ]
        : inputText,
    metadata: { model, apiMode, stream: streamMode, temperature, maxTokens, reasoningEffort, sendImagesOnlyOnce },
  }

  const allMessages: Message[] = [...messages, draftUserMessage]
  const sendMessages = includeChatHistory ? allMessages : [draftUserMessage]
  const imageContext = summarizeImageContext(sendMessages, draftUserMessage.id, sendImagesOnlyOnce)
  const apiMessages: ApiChatMessage[] = prepareApiMessages(sendMessages, draftUserMessage.id, sendImagesOnlyOnce)

  return {
    model,
    apiMessages,
    draftUserMessage,
    imageContext,
  }
}

const createTemplateMessage = (
  templateInput: TemplateInput,
  model: string,
  {
    apiMode,
    includeChatHistory,
    messages,
    streamMode,
    sendImagesOnlyOnce,
    temperature,
    maxTokens,
    reasoningEffort,
  }: {
    apiMode: ApiMode
    includeChatHistory: boolean
    messages: Message[]
    streamMode: boolean
    sendImagesOnlyOnce: boolean
    temperature?: number
    maxTokens?: number
    reasoningEffort?: ReasoningEffort
  }
): BuiltChatMessages => {
  const draftUserMessage: Message = {
    id: uuidv7(),
    role: 'user',
    content: templateInput.content,
    metadata: {
      model: templateInput.model || model,
      apiMode,
      stream: streamMode,
      temperature,
      maxTokens,
      reasoningEffort,
      sendImagesOnlyOnce,
    },
  }
  const systemMessage: Message = {
    id: uuidv7(),
    role: 'system',
    content: templateInput.prompt,
  }

  const allMessages: Message[] =
    messages.length === 0 && templateInput ? [systemMessage, draftUserMessage] : [...messages, draftUserMessage]

  const sendMessages: Message[] = includeChatHistory ? allMessages : [systemMessage, draftUserMessage]
  const imageContext = summarizeImageContext(sendMessages, draftUserMessage.id, sendImagesOnlyOnce)
  const apiMessages: ApiChatMessage[] = prepareApiMessages(sendMessages, draftUserMessage.id, sendImagesOnlyOnce)

  return {
    model: templateInput.model || model,
    apiMessages,
    draftUserMessage,
    systemMessage,
    imageContext,
  }
}
