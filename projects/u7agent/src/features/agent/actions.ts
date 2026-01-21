'use server'

import { Experimental_Agent as Agent, generateText, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

import { handleAgentStreamError } from './errorHandler'
import { pickTools } from './tools'
import { AgentConfig } from './types'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ToolMessage {
  role: 'tools'
  content: {
    name: string
    inputJSON: string
    outputJSON: string
  }
}

export type AgentMessage = Message | ToolMessage

export interface TokenUsage {
  input: {
    noCache?: number
    cacheRead?: number
    cacheWrite?: number
  }
  output: {
    text?: number
    reasoning?: number
  }
}

export async function agentStream(messages: AgentMessage[], agentConfig: AgentConfig) {
  const output = createStreamableValue<{
    delta?: string
    tools?: ToolMessage[]
    finishReason?: string
    usage?: TokenUsage
    processingTimeMs?: number
  }>()

  ;(async () => {
    const startTimeMs = Date.now()
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
      prepareStep: ({ stepNumber }) => {
        // See: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#preparestep-callback
        console.log(`Preparing step (${stepNumber})`)
        // if (stepNumber === 1) {
        //   return {
        //     activeTools: [],　// 1ステップ目はツールを無効化する例(stepNumberは0始まり)
        //   }
        // }
        return undefined
      },
      onStepFinish: ({ toolResults }) => {
        const toolCalls = toolResults.map(({ toolName: name, input, output }) => ({
          name,
          inputJSON: JSON.stringify(input),
          outputJSON: JSON.stringify(output),
        }))
        console.log('Step finished. Tool results:', toolCalls)
        output.update({ tools: toolCalls.map((t) => ({ role: 'tools', content: t })) })
      },
      onFinish: ({ text, finishReason }) => {
        console.log('Agent finished:', { text, finishReason })
      },
    })

    const stream = await agent.stream({ prompt: messages.filter((m) => m.role !== 'tools') as Message[] })
    console.log('Agent stream started')

    let message = ''

    for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case 'text-delta':
          message += chunk.text
          output.update({ delta: chunk.text })
          break

        case 'finish':
          output.update({
            finishReason: chunk.finishReason,
            usage: {
              input: {
                noCache: chunk.totalUsage.inputTokenDetails.noCacheTokens,
                cacheRead: chunk.totalUsage.inputTokenDetails.cacheReadTokens,
                cacheWrite: chunk.totalUsage.inputTokenDetails.cacheWriteTokens,
              },
              output: {
                text: chunk.totalUsage.outputTokenDetails.textTokens,
                reasoning: chunk.totalUsage.outputTokenDetails.reasoningTokens,
              },
            },
          })
          break

        case 'error':
          const errorMessage = handleAgentStreamError(chunk.error)
          output.update({ delta: `Error: ${errorMessage}` })
          break
      }
    }

    console.log('Agent stream finished')
    output.update({ processingTimeMs: Date.now() - startTimeMs })
    output.done()
  })()

  return { output: output.value }
}
