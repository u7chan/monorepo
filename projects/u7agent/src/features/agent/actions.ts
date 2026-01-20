'use server'

import { Experimental_Agent as Agent, generateText, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

import { pickTools } from './tools'
import { AgentConfig } from './types'

export async function agentStream(
  messages: {
    role: 'user' | 'assistant' | 'system'
    content: string
  }[],
  agentConfig: AgentConfig,
) {
  const output = createStreamableValue<{ delta?: string }>()

  ;(async () => {
    const openai = createOpenAI({
      baseURL: process.env.LITELLM_API_BASE_URL!,
      apiKey: process.env.LITELLM_API_KEY!,
    })

    // If the agent config does not specify tools (or lists an empty array),
    // do not expose any tools to the agent. This prevents agents without an
    // explicit tool allowlist from accessing system tools by default.
    const tools = agentConfig.tools && agentConfig.tools.length > 0 ? pickTools(agentConfig.tools) : undefined

    const agent = new Agent({
      model: openai(agentConfig.model),
      instructions: [{ role: 'system', content: agentConfig.instruction }],
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

    const stream = await agent.stream({ prompt: messages })
    console.log('Agent stream started')

    let message = ''

    for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case 'text-delta':
          message += chunk.text
          output.update({ delta: chunk.text })
          break
        case 'error':
          if (typeof chunk.error === 'string') {
            console.warn('[WARN] Agent stream chunk error (string)', chunk.error)
            // output.update({ delta: `Error: ${chunk.error}` })
            break
          }
          console.error('[ERROR] Agent stream chunk error (object)', chunk.error)

          // 安全にerrorMessage抽出（パターン対応）
          let errorMessage = 'Unknown error'

          if (chunk.error) {
            // パターン1: { error: { message: string } }
            if (typeof chunk.error === 'object' && chunk.error !== null && 'error' in chunk.error) {
              errorMessage = (chunk.error as any).error?.message ?? errorMessage
            }

            // パターン2: ErrorインスタンスのresponseBodyから抽出
            if ('responseBody' in (chunk.error as any) && typeof (chunk.error as any).responseBody === 'string') {
              try {
                const body = JSON.parse((chunk.error as any).responseBody)
                errorMessage = body.error?.message ?? errorMessage
              } catch {
                // parse失敗時はresponseBodyそのまま
                errorMessage = (chunk.error as any).responseBody
              }
            }
          }

          output.update({ delta: `Error: ${errorMessage}` })
          break
      }
    }

    console.log('Agent stream finished: ', { message })
    output.done()
  })()

  return { output: output.value }
}
