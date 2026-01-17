import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'
import z from 'zod'

export type CompletionChunk = OpenAI.ChatCompletion & {
  choices: {
    message: {
      reasoning_content?: string // OpenAI APIでは提供されていないフィールド。LiteLLM経由の推論モデルでのみ取得可能。
    }
  }[]
  usage?: {
    completion_tokens_details?: {
      reasoning_tokens: number // OpenAI APIでは提供されていないフィールド。LiteLLM経由の推論モデルでのみ取得可能。
    }
  }
}
export type StreamCompletionChunk = OpenAI.ChatCompletionChunk & {
  choices: {
    delta: {
      reasoning_content?: string // OpenAI APIでは提供されていないフィールド。LiteLLM経由の推論モデルでのみ取得可能。
    }
  }[]
  usage?: {
    completion_tokens_details?: {
      reasoning_tokens: number // OpenAI APIでは提供されていないフィールド。LiteLLM経由の推論モデルでのみ取得可能。
    }
  }
}
export type StreamChunk = Stream<StreamCompletionChunk>
type Completions = CompletionChunk | StreamChunk

export const MessageSchema = z.union([
  z.object({
    role: z.enum(['system']),
    content: z.string().min(1),
  }),
  z.object({
    role: z.enum(['assistant']),
    content: z.string().min(1),
  }),
  z.object({
    role: z.enum(['user']),
    content: z.union([
      z.string().min(1),
      z
        .union([
          z.object({
            type: z.enum(['text']),
            text: z.string().min(1),
          }),
          z.object({
            type: z.enum(['image_url']),
            image_url: z.object({
              url: z.string().min(1),
              detail: z.enum(['auto', 'low', 'high']).optional(),
            }),
          }),
        ])
        .array(),
    ]),
  }),
])

interface Chat {
  completions(
    headers: {
      apiKey: string
      baseURL: string
      mcpServerURLs: string
    },
    params: {
      model: string
      messages: z.infer<typeof MessageSchema>[]
      temperature?: number
      maxTokens?: number
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
      stream,
      includeUsage,
    }: {
      model: string
      messages: z.infer<typeof MessageSchema>[]
      temperature?: number
      maxTokens?: number
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
