'use server'

import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

export async function generate(model: string, input: string) {
  const stream = createStreamableValue('')

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.OPENAI_API_BASE_URL!,
      apiKey: process.env.OPENAI_API_KEY!,
    })
    const { textStream } = streamText({
      model: openai(model),
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
