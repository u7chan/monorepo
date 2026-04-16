import type { ChatResponse, ChatStreamEvent, ChatUsage } from '#/types/chat-api'
import type { CompletionChunk, StreamCompletionChunk, StreamChunk } from './transport'

// ============================================
// 非ストリーム変換
// ============================================

export function convertCompletion(raw: CompletionChunk): ChatResponse {
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
    usage: normalizeUsage(raw.usage),
  }
}

// ============================================
// ストリーム変換
// ============================================

export async function* convertStreamChunks(raw: StreamChunk): AsyncGenerator<ChatStreamEvent> {
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
      const usage = normalizeUsage(chunk.usage)
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

  // LiteLLM: message.reasoning_content を優先
  if (message.reasoning_content) return message.reasoning_content
  if (message.provider_specific_fields?.reasoning_content) return message.provider_specific_fields.reasoning_content

  // Bifrost: message.reasoning を優先、なければ reasoning_details[].text を結合
  if (message.reasoning) return message.reasoning
  if (message.reasoning_details?.length) {
    return message.reasoning_details.map((d) => d.text).join('')
  }

  return ''
}

function extractStreamReasoning(delta: StreamCompletionChunk['choices'][0]['delta'] | undefined): string | undefined {
  if (!delta) return undefined

  // LiteLLM: delta.reasoning_content
  if (delta.reasoning_content !== undefined) return delta.reasoning_content
  // Bifrost: delta.reasoning
  if (delta.reasoning !== undefined) return delta.reasoning

  return undefined
}

type RawUsage = CompletionChunk['usage'] | StreamCompletionChunk['usage']

function normalizeUsage(usage: RawUsage): ChatUsage | null {
  if (!usage) return null
  if (usage.prompt_tokens === undefined || usage.completion_tokens === undefined || usage.total_tokens === undefined) {
    return null
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  }
}
