import { ReadableStream } from 'node:stream/web'
import type { LLMProvider, Messages, Reader } from './types'

const HIRAGANA =
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん\n'
const CHUNK_SIZE = 5
const MAX_CHUNKS = 500

function createDummyStream(): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0
  let chunkCount = 0

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = ''
      for (let i = 0; i < CHUNK_SIZE; i++) {
        chunk += HIRAGANA[index]
        index = (index + 1) % HIRAGANA.length
      }
      const data = {
        id: `${chunkCount}`,
        model: 'dummy',
        choices: [{ delta: { content: `${chunk}` }, finishReason: null }],
        usage: null,
      }
      const payload = `data: ${JSON.stringify(data)}\n`
      controller.enqueue(new TextEncoder().encode(payload))
      chunkCount++

      await new Promise((resolve) => setTimeout(resolve, 50)) // delay

      if (chunkCount >= MAX_CHUNKS) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'))
        controller.close()
      }
    },
  })

  return stream.getReader()
}

export class TestProvider implements LLMProvider {
  async chatStream(
    _messages: Messages[],
    _temperature?: number | null,
    _maxTokens?: number | null,
  ): Promise<Reader> {
    await new Promise((resolve) => setTimeout(resolve, 1000)) // delay
    return createDummyStream()
  }
}
