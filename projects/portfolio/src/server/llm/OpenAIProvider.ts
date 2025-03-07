import type { LLMProvider, Messages, Reader } from './types'

export class OpenAIProvider implements LLMProvider {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async chatStream(
    model: string,
    messages: Messages[],
    temperature?: number | null,
    maxTokens?: number | null,
  ): Promise<Reader> {
    const url = 'https://api.openai.com/v1/chat/completions'

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
        stream: true,
      }),
    })

    if (!res.ok) {
      const json = await res.json()
      throw new Error(json.error.message)
    }

    const reader = res.body?.getReader()
    if (!reader) {
      throw new Error('Failed to stream response')
    }

    return reader
  }
}
