import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { sValidator } from '@hono/standard-validator'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
// import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { APICallError, experimental_createMCPClient as createMCPClient, streamText } from 'ai'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

const app = new Hono()

const chatRequestSchema = z.object({
  messages: z
    .object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().min(1),
    })
    .array()
    .min(1),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().min(1).optional(),
})

app.post('/api/chat/completions', sValidator('json', chatRequestSchema), async (c) => {
  console.log('Received chat request:', c.req.valid('json'))
  const req = c.req.valid('json')

  // OpenAI互換のクライアントを作成
  const litellm = createOpenAICompatible({
    name: 'litellm',
    baseURL: process.env.LITELLM_API_BASE_URL ?? '',
    headers: {
      Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? ''}`,
    },
  })

  const useModel = req.model ?? process.env.LITELLM_DEFAULT_MODEL
  if (!useModel) {
    return c.json({ error: 'Model is required' }, 400)
  }

  // MCPツールの取得する関数
  const getMcpTools = async () => {
    if (!process.env.MCP_API_BASE_URL) {
      return undefined
    }
    // MCPクライアントを作成
    const mcpClient = await createMCPClient({
      transport: new SSEClientTransport(new URL(process.env.MCP_API_BASE_URL)),
    })
    // toolsを取得
    return await mcpClient.tools()
  }

  // AI SDKを使用してテキストをストリーミング
  const result = streamText({
    model: litellm(useModel),
    messages: req.messages,
    maxSteps: 5,
    tools: await getMcpTools(),
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    onError: ({ error: apiError }: { error: unknown }) => {
      if (APICallError.isInstance(apiError)) {
        console.error('API call error:', apiError.message)
        const { error } = JSON.parse(apiError.message.replace(/'/g, '"')) as { error: string }
        const errorMessage = error
        throw new Error(errorMessage)
      }
    },
    onFinish: () => {
      console.log('Stream finished')
    },
  })

  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => {
      aborted = true
      console.log('Stream aborted')
    })

    let id = ''
    let model: string | undefined
    const created = Math.floor(Date.now() / 1000)

    const sendChunk = async (
      delta: { content?: string },
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
    let numStep = 1

    // ストリームのチャンク処理
    for await (const chunk of result.fullStream) {
      if (aborted) {
        break
      }
      console.log(`chunk.type: ${chunk.type}`)
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
        case 'tool-result':
          console.log(`<- ${chunk.toolName}`)
          break
        case 'text-delta':
          sendChunk({ content: chunk.textDelta })
          break
        case 'finish':
          console.log({
            finish_reason: chunk.finishReason,
            usage: chunk.usage,
          })
          sendChunk({}, chunk.finishReason, {
            prompt_tokens: chunk.usage.promptTokens,
            completion_tokens: chunk.usage.completionTokens,
            total_tokens: chunk.usage.totalTokens,
          })
          break
      }
    }

    // ストリームの終了シグナル
    await stream.writeSSE({
      data: '[DONE]',
    })
  })
})

export default app
