import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { sValidator } from '@hono/standard-validator'
import { APICallError, streamText } from 'ai'
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
})

app.post('/api/chat/completions', sValidator('json', chatRequestSchema), async (c) => {
  console.log('Received chat request:', c.req.valid('json'))
  const req = c.req.valid('json')

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

  const result = streamText({
    model: litellm(useModel),
    messages: req.messages,
    maxSteps: 5,
    // maxTokens: 4096,
    // temperature: 0.7,
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
    let id = ''
    let finish_reason = ''
    let model: string | undefined
    let usage = {
      promptTokens: -1,
      completionTokens: -1,
      totalTokens: -1,
    }
    const created = Math.floor(Date.now() / 1000)

    // ストリームのチャンク処理
    for await (const chunk of result.fullStream) {
      let chunkText = ''

      switch (chunk.type) {
        case 'step-start':
          id = chunk.messageId
          break
        case 'step-finish':
          finish_reason = chunk.finishReason
          usage = chunk.usage
          model = chunk.response.modelId
          break
        case 'text-delta':
          chunkText = chunk.textDelta
          break
      }

      await stream.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                content: chunkText,
              },
              finish_reason: null,
            },
          ],
        }),
      })
    }

    // 終了チャンク処理
    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason,
          },
        ],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
      }),
    })

    // ストリームの終了シグナル
    await stream.writeSSE({
      data: '[DONE]',
    })
  })
})

export default app
