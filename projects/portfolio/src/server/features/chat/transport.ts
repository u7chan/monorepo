import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'

/**
 * サーバー内部 transport 型
 * LiteLLM 経由の推論モデルが返す拡張フィールドを含む OpenAI レスポンス型。
 * これらは OpenAI 公式 API では提供されていない。
 */

export type CompletionChunk = OpenAI.ChatCompletion & {
  choices: {
    message: {
      reasoning_content?: string // LiteLLM 経由の推論モデル
      reasoning?: string // Bifrost 経由の推論モデル
      reasoning_details?: Array<{ type: string; text: string }> // Bifrost fallback
      provider_specific_fields?: { reasoning_content?: string } // LiteLLM fallback
    }
  }[]
  usage?: {
    reasoning_tokens?: number
    completion_tokens_details?: {
      reasoning_tokens: number
    }
  }
}

export type StreamCompletionChunk = OpenAI.ChatCompletionChunk & {
  choices: {
    delta: {
      reasoning_content?: string // LiteLLM 経由の推論モデル
      reasoning?: string // Bifrost 経由の推論モデル
    }
  }[]
  usage?: {
    reasoning_tokens?: number
    completion_tokens_details?: {
      reasoning_tokens: number
    }
  }
}

export type StreamChunk = Stream<StreamCompletionChunk>

export type Completions = CompletionChunk | StreamChunk
