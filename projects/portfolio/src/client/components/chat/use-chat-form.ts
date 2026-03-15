import type { TemplateInput } from '#/client/components/chat/prompt-template'
import type { ChatMessage, ChatMessageSystem, ChatMessageUser } from '#/types'
import { type ChangeEvent, type KeyboardEvent, type RefObject, useEffect, useState } from 'react'

const MIN_TEXT_LINE_COUNT = 2
const MAX_TEXT_LINE_COUNT = 5

interface UseChatFormParams {
  initTrigger?: number
  formRef: RefObject<HTMLFormElement | null>
}

interface BuildChatMessagesParams {
  interactiveMode: boolean
  messages: ChatMessage[]
  model: string
}

interface BuiltChatMessages {
  model: string
  messages: ChatMessage[]
}

export function useChatForm({ initTrigger, formRef }: UseChatFormParams) {
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
      if (content && formRef.current) {
        formRef.current.requestSubmit()
      }
    }
  }

  const buildChatMessages = ({
    interactiveMode,
    messages,
    model,
  }: BuildChatMessagesParams): BuiltChatMessages | null => {
    if (templateInput) {
      return createTemplateMessage(templateInput, model, { interactiveMode, messages })
    }

    return createMessage(input.trim(), model, { interactiveMode, messages, uploadImages })
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
    interactiveMode,
    messages,
    uploadImages,
  }: { interactiveMode: boolean; messages: ChatMessage[]; uploadImages: string[] }
): BuiltChatMessages | null => {
  if (!inputText) {
    return null
  }

  const userMessage: ChatMessageUser = {
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
  }
  const newMessages: ChatMessage[] = [...messages, userMessage]

  return {
    model,
    messages: interactiveMode ? newMessages : [userMessage],
  }
}

const createTemplateMessage = (
  templateInput: TemplateInput,
  model: string,
  { interactiveMode, messages }: { interactiveMode: boolean; messages: ChatMessage[] }
): BuiltChatMessages => {
  const userMessage: ChatMessageUser = {
    role: 'user',
    content: templateInput.content,
  }
  const systemMessage: ChatMessageSystem = {
    role: 'system',
    content: templateInput.prompt,
  }
  const newMessages: ChatMessage[] =
    messages.length === 0 && templateInput ? [systemMessage, userMessage] : [...messages, userMessage]

  return {
    model: templateInput.model || model,
    messages: interactiveMode ? newMessages : [systemMessage, userMessage],
  }
}
