export type Reader = ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>

export interface Messages {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMProvider {
  chatStream: (
    model: string,
    messages: Messages[],
    temperature?: number | null,
    maxTokens?: number | null,
  ) => Promise<Reader>
}
