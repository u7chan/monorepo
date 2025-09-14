'use server'

import { streamText, generateText, APICallError } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

export async function generate(model: string, input: string) {
  const openai = createOpenAI({
    baseURL: process.env.LITELLM_API_BASE_URL!,
    apiKey: process.env.LITELLM_API_KEY!,
  })

  try {
    const response = await generateText({
      model: openai(model),
      prompt: input,
    })
    return { output: response.text }
  } catch (error) {
    console.error('Error generating text:', error)
    if (error instanceof APICallError) {
      return { output: error.responseBody || error.message }
    }
  }
}

export async function generateStream(model: string, input: string) {
  const stream = createStreamableValue('')

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
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
