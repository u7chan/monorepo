import type { ApiChatMessage, ApiMode } from '#/types'
import OpenAI from 'openai'
import type * as ResponsesAPI from 'openai/resources/responses/responses'
import type { Completions, ResponsesCompletion, ResponsesStreamChunk } from './transport'

export type {
  CompletionChunk,
  ResponsesCompletion,
  ResponsesStreamEvent,
  ResponsesStreamChunk,
  StreamCompletionChunk,
  StreamChunk,
} from './transport'

interface Chat {
  completions(
    headers: {
      apiKey: string
      baseURL: string
    },
    params: {
      apiMode: ApiMode
      model: string
      messages: ApiChatMessage[]
      temperature?: number
      maxTokens?: number
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      stream: boolean
      includeUsage?: boolean
    }
  ): Promise<Completions>
}

export const chat: Chat = {
  async completions(
    {
      apiKey,
      baseURL,
    }: {
      apiKey: string
      baseURL: string
    },
    {
      apiMode,
      model,
      messages,
      temperature,
      maxTokens,
      reasoningEffort,
      stream,
      includeUsage,
    }: {
      apiMode: ApiMode
      model: string
      messages: ApiChatMessage[]
      temperature?: number
      maxTokens?: number
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      stream: boolean
      includeUsage?: boolean
    }
  ): Promise<Completions> {
    const openai = new OpenAI({
      apiKey,
      baseURL,
    })

    if (apiMode === 'responses') {
      return (await openai.responses.create({
        model,
        input: convertToResponsesInput(messages),
        temperature,
        max_output_tokens: maxTokens,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        stream,
      })) as ResponsesCompletion | ResponsesStreamChunk
    }

    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
      stream,
      stream_options: includeUsage
        ? {
            include_usage: !!includeUsage,
          }
        : undefined,
    })
    return completion as Completions
  },
}

function convertToResponsesInput(messages: ApiChatMessage[]): ResponsesAPI.ResponseInput {
  return messages.map((message) => {
    if (message.role === 'system' || message.role === 'assistant') {
      return {
        type: 'message',
        role: message.role,
        content: message.content,
      }
    }

    return {
      type: 'message',
      role: 'user',
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((content) =>
              content.type === 'text'
                ? {
                    type: 'input_text' as const,
                    text: content.text,
                  }
                : {
                    type: 'input_image' as const,
                    image_url: content.image_url.url,
                    detail: 'auto' as const,
                  }
            ),
    }
  })
}
