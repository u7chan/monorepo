'use server'

import { Experimental_Agent as Agent, generateText, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

import { getShortTermMemory, saveShortTermMemory } from '@/features/memory/short-term-memory'
import { pickTools } from './tools'
import { AgentConfig } from './types'

export async function agentStream(input: string, agentConfig: AgentConfig) {
  const output = createStreamableValue<{ delta?: string }>()

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
    })

    const shortTermMemory = (await getShortTermMemory()) || 'なし'
    const instructions = `${agentConfig.instruction}
      記憶:
      - 直近の会話履歴: ${shortTermMemory}
      `
    console.log('Instructions:', instructions)

    // If the agent config does not specify tools (or lists an empty array),
    // do not expose any tools to the agent. This prevents agents without an
    // explicit tool allowlist from accessing system tools by default.
    const tools = agentConfig.tools && agentConfig.tools.length > 0 ? pickTools(agentConfig.tools) : undefined

    const agent = new Agent({
      model: openai(agentConfig.model),
      instructions,
      tools,
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
      onFinish: ({ text, finishReason }) => {
        console.log('Agent finished:', { text, finishReason })
      },
    })

    const stream = await agent.stream({ prompt: input })
    console.log('Agent stream started')

    let message = ''

    for await (const chunk of stream.textStream) {
      message += chunk
      output.update({ delta: chunk })
    }

    console.log('Agent stream finished')

    if (message.length > 0) {
      console.log('Final message from agent:', message)
      const { text: summarized } = await generateText({
        model: openai(agentConfig.summarizeModel || agentConfig.model),
        prompt: `会話の内奥を要約してください。
          直近の会話: ${shortTermMemory}
          ユーザー: ${input}
          アシスタント: ${message}
          `,
      })

      console.log('Saving summarized short-term memory:', summarized)
      await saveShortTermMemory(summarized)

      console.log('Short-term memory updated')
    }

    output.done()
  })()
    .then()
    .catch((error) => {
      console.error('### Error in agentStream:', error)
      output.error(error)
    })

  return { output: output.value }
}
