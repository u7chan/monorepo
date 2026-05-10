import type { ApiChatMessage, ImageContent, ImageContextSummary, Message, TextContent, UserMessage } from '#/types'
import { isImageContentArray, toApiChatMessage } from '#/types'

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  return message.content
    .filter((content): content is TextContent => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
}

export function buildEditedHistory(messages: Message[], index: number, nextText: string): Message[] | null {
  const target = messages[index]
  const trimmedText = nextText.trim()

  if (!target || target.role !== 'user' || trimmedText.length <= 0) {
    return null
  }

  return [
    ...messages.slice(0, index),
    {
      ...target,
      content: replaceUserTextContent(target.content, trimmedText),
    },
  ]
}

export function prepareApiMessages(
  messages: Message[],
  currentUserMessageId: string | undefined,
  sendImagesOnlyOnce: boolean
): ApiChatMessage[] {
  if (!sendImagesOnlyOnce) {
    return messages.map(toApiChatMessage)
  }

  return messages.map((message) => toApiChatMessage(stripImagesFromHistory(message, currentUserMessageId)))
}

export function buildEditedSendMessages(
  editedMessages: Message[],
  currentUserMessageId: string | undefined,
  includeChatHistory: boolean
): Message[] {
  if (includeChatHistory) {
    return editedMessages
  }

  const currentUserMessageIndex = editedMessages.findIndex(
    (message) => message.role === 'user' && message.id === currentUserMessageId
  )
  const currentUserMessage = editedMessages[currentUserMessageIndex]
  if (!currentUserMessage) {
    return []
  }

  const previousMessages = editedMessages.slice(0, currentUserMessageIndex)
  const systemPrefix = previousMessages.every((message) => message.role === 'system') ? previousMessages : []
  return [...systemPrefix, currentUserMessage]
}

export function summarizeImageContext(
  messages: Message[],
  currentUserMessageId: string | undefined,
  sendImagesOnlyOnce: boolean
): ImageContextSummary {
  const totalImages = messages.reduce((count, message) => count + countImages(message), 0)
  const currentImages = messages.reduce((count, message) => {
    if (message.role !== 'user' || message.id !== currentUserMessageId) {
      return count
    }
    return count + countImages(message)
  }, 0)

  if (!sendImagesOnlyOnce) {
    return {
      policy: 'full_history',
      sent: totalImages,
      historyOnly: 0,
    }
  }

  return {
    policy: 'send_once',
    sent: currentImages,
    historyOnly: totalImages - currentImages,
  }
}

function replaceUserTextContent(content: UserMessage['content'], nextText: string): UserMessage['content'] {
  if (typeof content === 'string') {
    return nextText
  }

  let replaced = false
  const nextContent = content.map((item) => {
    if (item.type !== 'text') {
      return item
    }

    replaced = true
    return {
      ...item,
      text: nextText,
    }
  })

  return replaced ? nextContent : [{ type: 'text', text: nextText }, ...nextContent]
}

function stripImagesFromHistory(message: Message, currentUserMessageId: string | undefined): Message {
  if (message.role !== 'user' || message.id === currentUserMessageId || !isImageContentArray(message.content)) {
    return message
  }

  const textContent = message.content.filter((content): content is TextContent => content.type === 'text')
  const nonEmptyTextContent = textContent.filter((content) => content.text.trim().length > 0)

  if (nonEmptyTextContent.length === 0) {
    return {
      ...message,
      content: '[image omitted from context]',
    }
  }

  return {
    ...message,
    content: nonEmptyTextContent,
  }
}

function countImages(message: Message): number {
  if (message.role !== 'user' || !isImageContentArray(message.content)) {
    return 0
  }

  return message.content.filter((content): content is ImageContent => content.type === 'image_url').length
}
