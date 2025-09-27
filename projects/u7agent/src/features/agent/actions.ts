'use server'

import { Experimental_Agent as Agent, generateText, stepCountIs, tool } from 'ai'
import z from 'zod'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

import { AgentConfig } from './types'

export async function agentStream(input: string, agentConfig: AgentConfig) {
  const output = createStreamableValue<{ delta?: string; summarized?: string }>()

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
    })

    const agent = new Agent({
      model: openai(agentConfig.model),
      system: agentConfig.instruction,
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
      stopWhen: [stepCountIs(agentConfig.maxSteps)],
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
      model: openai(agentConfig.summarizeModel || agentConfig.model),
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
