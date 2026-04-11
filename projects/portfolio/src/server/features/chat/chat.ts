import type { ApiChatMessage } from '#/types'
import OpenAI from 'openai'
import type { Completions, StreamChunk } from './transport'

export type { CompletionChunk, StreamCompletionChunk, StreamChunk } from './transport'

interface Chat {
  completions(
    headers: {
      apiKey: string
      baseURL: string
      mcpServerURLs: string
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
      mcpServerURLs,
    }: {
      apiKey: string
      baseURL: string
      mcpServerURLs: string
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
      fetch: async (url, options = {}) => {
        // カスタムヘッダーを追加
        const customHeaders = {
          'mcp-server-urls': mcpServerURLs,
        }
        // options.headers の型をチェックして、適切にマージ
        let existingHeaders: Record<string, string> = {}

        if (options.headers instanceof Headers) {
          // Headersオブジェクトの場合は安全にRecord<string, string>に変換
          existingHeaders = {}
          options.headers.forEach((value, key) => {
            if (typeof key === 'string' && typeof value === 'string') {
              existingHeaders[key] = value
            }
          })
        } else if (typeof options.headers === 'object' && options.headers !== null) {
          // plain objectの場合は安全にフィルタリングしてコピー
          existingHeaders = Object.fromEntries(
            Object.entries(options.headers).filter(
              ([key, value]) => typeof key === 'string' && typeof value === 'string'
            )
          )
        }
        // マージして新しいヘッダーをセット
        options.headers = {
          ...existingHeaders,
          ...customHeaders,
        }
        return fetch(url, options)
      },
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
