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

export type Completions = CompletionChunk | StreamChunk
