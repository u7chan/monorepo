import { createOpenAI } from '@ai-sdk/openai'
import { sValidator } from '@hono/standard-validator'
import { streamText } from 'ai'
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
})

app.post('/api/chat/completions', sValidator('json', chatRequestSchema), async (c) => {
  console.log('Received chat request:', c.req.valid('json'))
  const { messages } = c.req.valid('json')

  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL,
  })

  const result = streamText({
    model: openai.responses('gpt-4.1-nano'),
    messages,
    maxSteps: 5,
    onError: (error) => {
      console.error('Stream error:', error)
    },
    onFinish: () => {
      console.log('Stream finished')
    },
  })

  return streamSSE(c, async (stream) => {
    const id = `chatcmpl-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    for await (const chunk of result.textStream) {
      const responseChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: 'gpt-4.1-nano',
        choices: [
          {
            index: 0,
            delta: {
              content: chunk,
            },
            finish_reason: null,
          },
        ],
      }
      await stream.writeSSE({
        data: JSON.stringify(responseChunk),
      })
    }
    const usage = await result.usage
    console.log('usage:', usage)
    // 終了チャンク
    const finishChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'gpt-4.1-nano',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    }

    await stream.writeSSE({
      data: JSON.stringify(finishChunk),
    })

    await stream.writeSSE({
      data: '[DONE]',
    })
  })
})

export default app
