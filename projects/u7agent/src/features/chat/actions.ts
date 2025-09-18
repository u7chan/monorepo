'use server'

import { Experimental_Agent as Agent } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

export async function generateStream(model: string, input: string) {
  const output = createStreamableValue('')

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
    })

    const agent = new Agent({
      model: openai(model),
      system: "You are a helpful assistant that accurately answers the user's question.",
    })

    const stream = agent.stream({ prompt: input })

    for await (const chunk of stream.textStream) {
      output.update(chunk)
    }

    output.done()
  })()

  return { output: output.value }
}
