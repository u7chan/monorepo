import type { ChatResponse } from '#/types/chat-api'

export const hasAssistantOutput = ({ content, reasoningContent }: ChatResponse['message']): boolean =>
  content.length > 0 || reasoningContent.length > 0
