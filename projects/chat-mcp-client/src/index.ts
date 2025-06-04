import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { sValidator } from '@hono/standard-validator'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
// import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  APICallError,
  type Tool,
  experimental_createMCPClient as createMCPClient,
  streamText,
} from 'ai'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

const app = new Hono()

const chatRequestSchema = z.object({
  // OpenAIの Chat Completion APIのリクエストに準拠
  model: z.string().min(1).optional(),
  messages: z
    .object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().min(1),
    })
    .array()
    .min(1),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().min(1).optional(),
  // 拡張フィールド (OpenAIに準拠していない独自パラメータ)
  mcpServerUrls: z.string().array().optional(),
})

async function fetchMcpTools(baseUrl: string) {
  const mcpClient = await createMCPClient({
    transport: new SSEClientTransport(new URL(baseUrl)),
  })
  return await mcpClient.tools()
}

async function fetchMcpToolsFromServers(serverUrls: string[], filters?: string[]) {
  const filteredTools: { [k: string]: Tool } = {}
  for (const baseUrl of serverUrls) {
    const tools = await fetchMcpTools(baseUrl)
    const availableTools = Object.keys(tools).filter((key) =>
      filters ? filters.includes(key) : true,
    )
    for (const key of availableTools) {
      console.log(`AvailableTool: ${key}, ${tools[key].description}`)
      filteredTools[key] = tools[key]
    }
  }
  return filteredTools
}

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

  const tools = await fetchMcpToolsFromServers(req.mcpServerUrls ?? [])

  // AI SDKを使用してテキストをストリーミング
  const result = streamText({
    model: litellm(useModel),
    messages: req.messages,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    tools,
    maxSteps: 1, // 最低1以上。LLM呼び出しの無限ループを防ぐために、最大数を設定する必要がある。
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
    let id = ''
    let model: string | undefined
    let numStep = 1
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

    stream.onAbort(() => {
      aborted = true
      console.log('Stream aborted')
    })

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
        // case 'tool-result':
        //   console.log(`<- ${chunk.toolName}`)
        //   break
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
