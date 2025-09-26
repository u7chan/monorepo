'use server'

import { generateText, Experimental_Agent as Agent, stepCountIs, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'
import z from 'zod'

export async function generateStream(model: string, input: string) {
  const output = createStreamableValue<{ delta?: string; summarized?: string }>()

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
    })

    const agent = new Agent({
      model: openai(model),
      system: `あなたは優れたAIエージェントです。
      ルール:
        - 常に共感的かつ専門的に対応してください。
        - もしわからないことがあれば、その旨を伝え、エスカレートを提案してください。
        - 応答は簡潔で、実行可能な内容にしてください。
      `,
      tools: {
        weather: tool({
          description: '天気情報を取得します。',
          inputSchema: z.object({ location: z.string().describe('天気を取得する都市') }),
          execute: async ({ location }) => {
            // Mock weather data for demonstration purposes
            return {
              text: `${location}の天気は晴れで、気温は25°Cです。`,
              condition: '晴れ',
              temperature: 25,
            }
          },
        }),
        discord: tool({
          description: 'Discordチャンネルにメッセージを送信します。',
          inputSchema: z.object({
            channelId: z.string().describe('DiscordチャンネルのID'),
            message: z.string().describe('送信するメッセージ内容'),
          }),
          execute: async ({ channelId, message }) => {
            // Mock Discord message sending for demonstration purposes
            console.log(`Message sent to channel ${channelId}: ${message}`)
            return { success: true }
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

    let message = ''

    for await (const chunk of stream.textStream) {
      message += chunk
      output.update({ delta: chunk })
    }

    const { text: summarized } = await generateText({
      model: openai('gpt-4.1-nano'),
      prompt: `会話の内奥を要約してください。
      ユーザー: ${input}
      アシスタント: ${message}
      `,
    })

    output.update({ summarized })

    output.done()
  })()

  return { output: output.value }
}
