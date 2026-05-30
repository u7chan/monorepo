import type { ChatResponse } from '#/types/chat-api'

export const makeErrorResponse = (message: string): ChatResponse => ({
  id: '',
  created: 0,
  model: 'N/A',
  finishReason: '',
  message: { content: message, reasoningContent: '' },
  usage: null,
})

export const hasAssistantOutput = ({ content, reasoningContent }: ChatResponse['message']): boolean =>
  content.length > 0 || reasoningContent.length > 0
