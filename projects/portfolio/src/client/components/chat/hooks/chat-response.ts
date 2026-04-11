import {
  ChatCompletionResponseSchema,
  ChatCompletionStreamChunkSchema,
  type ChatCompletionResponse,
  type ChatCompletionResult,
  type ChatCompletionStreamChunk,
  type ChatResultSummary,
  type ChatStreamState,
} from '#/types'

type ApiUsage = ChatCompletionResponse['usage'] | ChatCompletionStreamChunk['usage']

export function parseChatCompletionResponse(value: unknown): ChatCompletionResponse {
  return ChatCompletionResponseSchema.parse(value)
}

export function parseChatCompletionStreamChunk(value: string): ChatCompletionStreamChunk {
  return ChatCompletionStreamChunkSchema.parse(JSON.parse(value))
}

export function updateChatStream(
  stream: ChatStreamState,
  chunk: ChatCompletionStreamChunk
): {
  stream: ChatStreamState
  finishReason: string
  model?: string
  usage: ChatResultSummary['usage']
} {
  const choice = chunk.choices.at(0)
  const nextStream = {
    content: stream.content + (choice?.delta.content ?? ''),
    reasoning_content: (stream.reasoning_content ?? '') + (choice?.delta.reasoning_content ?? ''),
  }

  return {
    stream: nextStream,
    finishReason: choice?.finish_reason ?? '',
    model: chunk.model,
    usage: normalizeUsage(chunk.usage),
  }
}

export function toChatCompletionResult(response: ChatCompletionResponse): ChatCompletionResult | null {
  const choice = response.choices.at(0)
  const content = choice?.message.content ?? ''

  if (!content) {
    return null
  }

  return {
    model: response.model ?? 'N/A',
    finishReason: choice?.finish_reason ?? '',
    message: {
      content,
      reasoningContent: choice?.message.reasoning_content ?? '',
    },
    responseTimeMs: 0,
    usage: normalizeUsage(response.usage),
  }
}

export function toChatResultSummary(params: {
  model?: string
  finishReason: string
  responseTimeMs?: number
  usage: ApiUsage
}): ChatResultSummary {
  return {
    model: params.model,
    finish_reason: params.finishReason,
    responseTimeMs: params.responseTimeMs,
    usage: normalizeUsage(params.usage),
  }
}

function normalizeUsage(usage: ApiUsage): ChatResultSummary['usage'] {
  if (!usage) {
    return null
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens,
  }
}
