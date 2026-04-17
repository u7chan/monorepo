import type { ApiChatMessage } from '#/types'
import OpenAI from 'openai'
import type { Completions, StreamChunk } from './transport'

export type { CompletionChunk, StreamCompletionChunk, StreamChunk } from './transport'

interface Chat {
  completions(
    headers: {
      apiKey: string
      baseURL: string
    },
    params: {
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
      model,
      messages,
      temperature,
      maxTokens,
      reasoningEffort,
      stream,
      includeUsage,
    }: {
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
