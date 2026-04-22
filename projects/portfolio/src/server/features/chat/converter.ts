import type { ApiMode } from '#/types'
import type { ChatResponse, ChatStreamEvent, ChatUsage } from '#/types/chat-api'
import type {
  CompletionChunk,
  ResponsesCompletion,
  ResponsesStreamChunk,
  ResponsesStreamEvent,
  StreamCompletionChunk,
  StreamChunk,
} from './transport'

// ============================================
// 非ストリーム変換
// ============================================

export function convertCompletion(apiMode: ApiMode, raw: CompletionChunk | ResponsesCompletion): ChatResponse {
  if (apiMode === 'responses') {
    return convertResponsesCompletion(raw as ResponsesCompletion)
  }

  return convertChatCompletionsCompletion(raw as CompletionChunk)
}

function convertChatCompletionsCompletion(raw: CompletionChunk): ChatResponse {
  const choice = raw.choices[0]
  const message = choice?.message

  return {
    id: raw.id,
    created: raw.created,
    model: raw.model,
    finishReason: choice?.finish_reason ?? '',
    message: {
      content: message?.content ?? '',
      reasoningContent: extractReasoning(message),
    },
    usage: normalizeChatCompletionsUsage(raw.usage),
  }
}

function convertResponsesCompletion(raw: ResponsesCompletion): ChatResponse {
  return {
    id: raw.id,
    created: raw.created_at,
    model: raw.model ?? '',
    finishReason: 'stop',
    message: {
      content: raw.output_text ?? extractResponsesOutputText(raw),
      reasoningContent: extractResponsesReasoning(raw),
    },
    usage: normalizeResponsesUsage(raw.usage),
  }
}

// ============================================
// ストリーム変換
// ============================================

export async function* convertStreamChunks(
  apiMode: ApiMode,
  raw: StreamChunk | ResponsesStreamChunk
): AsyncGenerator<ChatStreamEvent> {
  if (apiMode === 'responses') {
    yield* convertResponsesStreamChunks(raw as ResponsesStreamChunk)
    return
  }

  yield* convertChatCompletionsStreamChunks(raw as StreamChunk)
}

async function* convertChatCompletionsStreamChunks(raw: StreamChunk): AsyncGenerator<ChatStreamEvent> {
  let lastId = ''
  let lastCreated = 0
  let lastModel = ''

  for await (const chunk of raw) {
    if (chunk.id) lastId = chunk.id
    if (chunk.created) lastCreated = chunk.created
    if (chunk.model) lastModel = chunk.model

    const choice = chunk.choices[0]

    const content = choice?.delta?.content
    const reasoningContent = extractStreamReasoning(choice?.delta)

    if (content !== undefined || reasoningContent !== undefined) {
      yield {
        event: 'delta',
        id: lastId,
        created: lastCreated,
        model: lastModel,
        content: content ?? undefined,
        reasoningContent: reasoningContent ?? undefined,
      }
    }

    if (choice?.finish_reason) {
      yield {
        event: 'finish',
        id: lastId,
        created: lastCreated,
        model: lastModel,
        finishReason: choice.finish_reason,
      }
    }

    if (chunk.usage) {
      const usage = normalizeChatCompletionsUsage(chunk.usage)
      if (usage) {
        yield {
          event: 'usage',
          id: lastId,
          created: lastCreated,
          model: lastModel,
          usage,
        }
      }
    }
  }
}

async function* convertResponsesStreamChunks(raw: ResponsesStreamChunk): AsyncGenerator<ChatStreamEvent> {
  let lastId = ''
  let lastCreated = 0
  let lastModel = ''

  for await (const event of raw) {
    if (hasResponseMetadata(event)) {
      lastId = event.response.id
      lastCreated = event.response.created_at
      lastModel = event.response.model ?? ''
    }

    if (event.type === 'response.output_text.delta') {
      yield {
        event: 'delta',
        id: lastId,
        created: lastCreated,
        model: lastModel,
        content: event.delta,
      }
      continue
    }

    if (event.type === 'response.reasoning_text.delta') {
      yield {
        event: 'delta',
        id: lastId,
        created: lastCreated,
        model: lastModel,
        reasoningContent: event.delta,
      }
      continue
    }

    if (event.type === 'response.completed') {
      yield {
        event: 'finish',
        id: lastId,
        created: lastCreated,
        model: lastModel,
        finishReason: 'stop',
      }

      const usage = normalizeResponsesUsage(event.response.usage)
      if (usage) {
        yield {
          event: 'usage',
          id: lastId,
          created: lastCreated,
          model: lastModel,
          usage,
        }
      }
    }
  }
}

// ============================================
// ヘルパー
// ============================================

function extractReasoning(message: CompletionChunk['choices'][0]['message'] | undefined): string {
  if (!message) return ''

  if (message.reasoning_content) return message.reasoning_content
  if (message.provider_specific_fields?.reasoning_content) return message.provider_specific_fields.reasoning_content
  if (message.reasoning) return message.reasoning
  if (message.reasoning_details?.length) {
    return message.reasoning_details.map((detail) => detail.text).join('')
  }

  return ''
}

function extractStreamReasoning(delta: StreamCompletionChunk['choices'][0]['delta'] | undefined): string | undefined {
  if (!delta) return undefined
  if (delta.reasoning_content !== undefined) return delta.reasoning_content
  if (delta.reasoning !== undefined) return delta.reasoning
  return undefined
}

type RawChatCompletionsUsage = CompletionChunk['usage'] | StreamCompletionChunk['usage']

function normalizeChatCompletionsUsage(usage: RawChatCompletionsUsage): ChatUsage | null {
  if (!usage) return null
  if (usage.prompt_tokens === undefined || usage.completion_tokens === undefined || usage.total_tokens === undefined) {
    return null
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens,
  }
}

function normalizeResponsesUsage(usage: ResponsesCompletion['usage']): ChatUsage | null {
  if (!usage) return null

  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
  }
}

function extractResponsesOutputText(raw: ResponsesCompletion): string {
  const chunks: string[] = []

  for (const item of raw.output) {
    if (item.type !== 'message') continue

    for (const content of item.content) {
      if (content.type === 'output_text') {
        chunks.push(content.text)
      }
    }
  }

  return chunks.join('')
}

function extractResponsesReasoning(raw: ResponsesCompletion): string {
  const chunks: string[] = []

  for (const item of raw.output) {
    if (item.type !== 'reasoning') continue

    if (item.content?.length) {
      for (const content of item.content) {
        if (content.type === 'reasoning_text') {
          chunks.push(content.text)
        }
      }
      continue
    }

    for (const summary of item.summary) {
      chunks.push(summary.text)
    }
  }

  return chunks.join('')
}

function hasResponseMetadata(
  event: ResponsesStreamEvent
): event is Extract<ResponsesStreamEvent, { response: ResponsesCompletion }> {
  return 'response' in event
}
