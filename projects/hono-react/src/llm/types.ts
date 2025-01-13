export type Reader = ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>

export interface LLMProvider {
  chatStream: (message: string) => Promise<Reader>
}
