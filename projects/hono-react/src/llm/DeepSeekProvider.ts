import type { LLMProvider, Reader } from './types'

export class DeepSeekProvider implements LLMProvider {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async chatStream(
    message: string,
    temperature?: number | null,
    maxTokens?: number | null,
  ): Promise<Reader> {
    const model = 'deepseek-chat'
    const url = 'https://api.deepseek.com/chat/completions'

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
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
