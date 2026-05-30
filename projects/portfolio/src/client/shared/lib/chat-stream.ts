import { ChatStreamEventSchema, type ChatStreamEvent } from '#/types/chat-api'

export interface ChatStreamState {
  content: string
  reasoningContent: string
}

export function parseChatStreamEvent(value: string): ChatStreamEvent {
  return ChatStreamEventSchema.parse(JSON.parse(value))
}

export function updateChatStream(stream: ChatStreamState, event: ChatStreamEvent): ChatStreamState {
  if (event.event === 'delta') {
    return {
      content: stream.content + (event.content ?? ''),
      reasoningContent: stream.reasoningContent + (event.reasoningContent ?? ''),
    }
  }
  return stream
}
