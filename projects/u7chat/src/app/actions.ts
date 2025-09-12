'use server'

import { streamText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

export async function generate(input: string) {
  const stream = createStreamableValue('')

  ;(async () => {
    const { textStream } = streamText({
      model: openai('gpt-4.1-mini'),
      prompt: input,
      onError: ({ error }) => {
        stream.update(error instanceof Error ? error.message : String(error))
      },
    })

    for await (const delta of textStream) {
      stream.update(delta)
    }
    stream.done()
  })()

  return { output: stream.value }
}
