'use server'

import {
  stepCountIs,
  ToolLoopAgent,
  type TextPart,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
  type ToolCallPart,
} from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createStreamableValue } from '@ai-sdk/rsc'

import { env } from '@/env'
import { AgentConfig } from '@/features/agent-service/agent-config'
import { pickTools } from '@/features/agent-service/agent-tools'
import { handleAgentStreamError } from './agent-error'

interface Message {
  role: 'user' | 'system'
  content: string
}

type AssistantContent = TextPart | ToolCallPart | ToolApprovalRequest

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContent[]
}

export interface ToolCallPayload {
  name: string
  inputJSON: string
  outputJSON: string
}

interface ToolMessage {
  role: 'custom-tool-message'
  content: ToolCallPayload
}

interface ToolApprovalRequestMessage {
  role: 'custom-tool-approval-request'
  approvalId: string
  content: ToolCallPayload
}

export interface ToolApprovalMessage {
  role: 'tool'
  content: ToolApprovalResponse[]
}

export type AgentMessage = Message | AssistantMessage | ToolMessage | ToolApprovalRequestMessage | ToolApprovalMessage

export interface ModelUsage {
  model?: string
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
    assistantContent?: AssistantContent[]
    tools?: (ToolMessage | ToolApprovalRequestMessage)[] // TODO: もう配列じゃなくていいはず。単一要素に直すべき
    finishReason?: string
    usage?: ModelUsage
    processingTimeMs?: number
  }>()

  ;(async () => {
    const startTimeMs = Date.now()
    const openai = createOpenAI({
      baseURL: env.LITELLM_API_BASE_URL,
      apiKey: env.LITELLM_API_KEY,
    })

    // If the agent config does not specify tools (or lists an empty array),
    // do not expose any tools to the agent. This prevents agents without an
    // explicit tool allowlist from accessing system tools by default.
    const tools = agentConfig.tools && agentConfig.tools.length > 0 ? pickTools(agentConfig.tools) : undefined
    let agentMessage = ''
    const agent = new ToolLoopAgent({
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
      onFinish: ({ text }) => {
        agentMessage = text
      },
    })

    const filteredMessages = filterMessagesForAgent(messages)
    console.log('Starting agent stream with messages:', JSON.stringify(filteredMessages))
    const stream = await agent.stream({ prompt: filteredMessages })
    console.log('Agent stream started')

    let _message = ''
    let assistantContent: AssistantContent[] = []

    for await (const chunk of stream.fullStream) {
      // console.log('Agent stream chunk received:', JSON.stringify(chunk))
      switch (chunk.type) {
        case 'text-delta':
          _message += chunk.text
          output.update({ delta: chunk.text })
          break

        case 'tool-call':
          assistantContent.push({
            type: 'tool-call',
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          } as ToolCallPart)
          break

        case 'tool-approval-request': {
          const payload: ToolCallPayload = {
            name: chunk.toolCall.toolName,
            inputJSON: JSON.stringify(chunk.toolCall.input),
            outputJSON: '{}',
          }
          assistantContent.push({
            type: 'tool-approval-request',
            approvalId: chunk.approvalId,
            toolCallId: chunk.toolCall.toolCallId,
          } as ToolApprovalRequest)
          output.update({
            tools: [{ role: 'custom-tool-approval-request', approvalId: chunk.approvalId, content: payload }],
            assistantContent,
          })
          break
        }

        case 'tool-result':
          output.update({
            tools: [
              {
                role: 'custom-tool-message',
                content: {
                  name: chunk.toolName,
                  inputJSON: JSON.stringify(chunk.input),
                  outputJSON: JSON.stringify({ result: chunk.output }),
                },
              },
            ],
          })
          break

        case 'finish':
          output.update({
            finishReason: chunk.finishReason,
            usage: {
              model: agentConfig.model,
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

    if (agentMessage) {
      assistantContent.push({ type: 'text', text: agentMessage } as TextPart)
      output.update({ assistantContent })
    }

    console.log('Agent stream finished')
    output.update({ processingTimeMs: Date.now() - startTimeMs })
    output.done()
  })()

  return { output: output.value }
}

const TOOL_TYPES_TO_REMOVE = new Set(['tool-call', 'tool-approval-response'])

// TODO: まだ挙動があやしい。連続してApprovalツールを呼び出した時に期待通り動かない。
function filterMessagesForAgent(messages: AgentMessage[]) {
  // assistant の text が存在するか確認
  const hasAssistantText = messages.some(
    (m) => m.role === 'assistant' && m.content?.some((c) => c.type === 'text' && c.text?.trim()),
  )

  return (
    messages
      // 既存条件
      .filter((m) => m.role !== 'custom-tool-message' && m.role !== 'custom-tool-approval-request')
      // assistant の content を調整
      .map((m) => {
        if (hasAssistantText && m.role === 'assistant' && Array.isArray(m.content)) {
          return {
            ...m,
            content: m.content.filter((c) => !TOOL_TYPES_TO_REMOVE.has(c.type)),
          }
        }
        return m
      })
  )
}
