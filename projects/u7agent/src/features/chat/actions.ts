'use server'

import { Experimental_Agent as Agent, stepCountIs, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'
import z from 'zod'

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
      tools: {
        weather: tool({
          description: 'Get the current weather in a given city.',
          inputSchema: z.object({ location: z.string().describe('The city to get the weather for') }),
          execute: async ({ location }) => {
            // Mock weather data for demonstration purposes
            return {
              text: `The current weather in ${location} is sunny with a temperature of 25°C.`,
              condition: 'sunny',
              temperature: 25,
            }
          },
        }),
      },
      stopWhen: [stepCountIs(3)],
      prepareStep: ({ stepNumber, messages }) => {
        console.log(`Preparing step (${stepNumber}):`, JSON.stringify(messages))
        return undefined
      },
      onStepFinish: (step) => {
        console.log(`Step finished:`, {
          toolCalls: step.toolCalls.map(({ type, toolName, input }) => ({
            type,
            toolName,
            input: JSON.stringify(input),
          })),
          toolResults: step.toolResults.map(({ type, toolName, input }) => ({
            type,
            toolName,
            input: JSON.stringify(input),
          })),
        })
      },
    })

    const stream = agent.stream({ prompt: input })

    for await (const chunk of stream.textStream) {
      output.update(chunk)
    }

    output.done()
  })()

  return { output: output.value }
}
