import type { Settings } from '#/client/shared/storage/remote-storage-settings'
import type { ApiChatMessage, ImageContextSummary, Message } from '#/types'
import type { ChatResponse } from '#/types/chat-api'
import type { ImageGenerationResponse } from '#/types/image-generation-api'

const CONVERSATION_TITLE_MAX_LENGTH = 10

export function createConversationTitle(contentOrText: Message['content'] | string): string {
  if (typeof contentOrText !== 'string') {
    return ''
  }

  return contentOrText.slice(0, CONVERSATION_TITLE_MAX_LENGTH)
}

export function resolveChatRequestSettings(settings: Settings): {
  model: string
  baseURL: string
  apiKey: string
  temperature?: number
  maxTokens?: number
  reasoningEffort?: Settings['reasoningEffort']
} {
  return {
    model: settings.fakeMode ? 'fakemode' : settings.model,
    baseURL: settings.fakeMode ? 'fakemode' : settings.baseURL,
    apiKey: settings.fakeMode ? 'fakemode' : settings.apiKey,
    temperature: settings.temperatureEnabled ? settings.temperature : undefined,
    maxTokens: settings.maxTokens ? Number(settings.maxTokens) : undefined,
    reasoningEffort: settings.reasoningEffortEnabled ? settings.reasoningEffort : undefined,
  }
}

export function createAssistantMessage({
  assistantMessageId,
  result,
  apiMode,
  responseTimeMs,
  imageContext,
  apiContextMessages,
}: {
  assistantMessageId: string
  result: ChatResponse
  apiMode: Settings['apiMode']
  responseTimeMs?: number
  imageContext?: ImageContextSummary
  apiContextMessages?: ApiChatMessage[]
}): Message {
  return {
    id: assistantMessageId,
    role: 'assistant',
    content: result.message.content,
    reasoningContent: result.message.reasoningContent,
    metadata: {
      model: result.model,
      apiMode,
      finishReason: result.finishReason,
      responseTimeMs: responseTimeMs ?? 0,
      usage: {
        promptTokens: result.usage?.promptTokens || 0,
        completionTokens: result.usage?.completionTokens || 0,
        totalTokens: result.usage?.totalTokens || 0,
        reasoningTokens: result.usage?.reasoningTokens,
      },
      imageContext,
      apiContextMessages,
    },
  }
}

export function createImageGenerationAssistantMessage({
  assistantMessageId,
  result,
  responseTimeMs,
}: {
  assistantMessageId: string
  result: ImageGenerationResponse
  responseTimeMs?: number
}): Message {
  return {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    metadata: {
      model: result.model,
      finishReason: 'stop',
      responseTimeMs: responseTimeMs ?? 0,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
      generatedImages: [result.image],
    },
  }
}
