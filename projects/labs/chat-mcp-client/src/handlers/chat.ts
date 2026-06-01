import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, streamText } from 'ai'
import type { Context } from 'hono'
import { env } from 'hono/adapter'
import { streamSSE } from 'hono/streaming'
import type { ChatRequest } from '../schemas/chat'
import { fetchMcpToolsFromServers } from '../services/mcp'

interface Env {
  LITELLM_API_BASE_URL: string
  LITELLM_API_KEY: string
  LITELLM_API_DEFAULT_MODEL: string
}

export async function handleChatCompletions(req: ChatRequest, c: Context<{ Bindings: Env }>) {
  const envs = env(c)

  console.log('Received chat request:', req)

  const rawMcpServerUrls = c.req.header('mcp-server-urls') ?? ''
  const mcpServerUrls = rawMcpServerUrls
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  console.log('MCP Servers:', mcpServerUrls)

  const litellm = createOpenAICompatible({
    name: 'litellm',
    baseURL: envs.LITELLM_API_BASE_URL ?? '',
    headers: {
      Authorization: `Bearer ${envs.LITELLM_API_KEY ?? ''}`,
    },
  })

  const useModel = req.model || envs.LITELLM_API_DEFAULT_MODEL
  if (!useModel) {
    return c.json({ error: 'Model is required' }, 400)
  }

  const tools = await fetchMcpToolsFromServers(mcpServerUrls)

  console.log('Stream Start:', {
    model: useModel,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
  })

  const result = streamText({
    model: litellm(useModel),
    messages: req.messages,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    tools,
    maxSteps: 5,
    onError: ({ error: apiError }: { error: unknown }) => {
      if (APICallError.isInstance(apiError)) {
        console.error('API call error:', apiError.message)
        const { error } = JSON.parse(apiError.message.replace(/'/g, '"')) as { error: string }
        throw new Error(error)
      }
    },
    onFinish: () => {
      console.log('Stream finished')
    },
  })

  return streamSSE(c, async (stream) => {
    let aborted = false
    let id = ''
    let model: string | undefined
    let numStep = 1
    const created = Math.floor(Date.now() / 1000)

    const sendChunk = async (
      delta: { content?: string; reasoning_content?: string },
      finish_reason?: string,
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      },
    ) => {
      await stream.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason,
            },
          ],
          usage,
        }),
      })
    }

    stream.onAbort(() => {
      aborted = true
      console.log('Stream aborted')
    })

    let chunkType = ''
    let contentLenght = 0
    let reasoningContentLenght = 0

    for await (const chunk of result.fullStream) {
      if (aborted) {
        break
      }
      if (chunkType !== chunk.type) {
        chunkType = chunk.type
        console.log(`chunkType: ${chunkType}`)
      }
      switch (chunk.type) {
        case 'step-start':
          console.log(`-> step (${numStep})`)
          id = chunk.messageId
          break
        case 'step-finish':
          console.log(`<- step (${numStep})`)
          model = chunk.response.modelId
          ++numStep
          break
        case 'tool-call':
          console.log(`-> ${chunk.toolName}`)
          break
        case 'reasoning':
          reasoningContentLenght += chunk.textDelta.length
          sendChunk({ reasoning_content: chunk.textDelta })
          break
        case 'text-delta':
          contentLenght += chunk.textDelta.length
          sendChunk({ content: chunk.textDelta })
          break
        case 'finish':
          console.log({
            content_lenght: contentLenght,
            reasoning_content_lenght: reasoningContentLenght,
            finish_reason: chunk.finishReason,
            usage: chunk.usage,
          })
          sendChunk({}, chunk.finishReason, {
            prompt_tokens: Number.isNaN(chunk.usage.promptTokens) ? 0 : chunk.usage.promptTokens,
            completion_tokens: Number.isNaN(chunk.usage.completionTokens)
              ? 0
              : chunk.usage.completionTokens,
            total_tokens: Number.isNaN(chunk.usage.completionTokens)
              ? 0
              : chunk.usage.completionTokens,
          })
          break
      }
    }

    await stream.writeSSE({
      data: '[DONE]',
    })
  })
}
