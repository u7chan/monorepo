import type { LLMProvider, Reader } from './types'

export class OpenAIProvider implements LLMProvider {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async chatStream(message: string): Promise<Reader> {
    const model = 'gpt-4o-mini'
    const url = 'https://api.openai.com/v1/chat/completions'

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
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
