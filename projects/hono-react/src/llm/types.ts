export type Reader = ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>

export interface LLMProvider {
  chatStream: (message: string, temperature?: number, maxTokens?: number) => Promise<Reader>
}
