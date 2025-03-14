import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { validator } from 'hono/validator'
import { sValidator } from '@hono/standard-validator'
import { streamSSE, streamText } from 'hono/streaming'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

import { getLLMProvider } from './llm/getLLMProvider'
import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'

type Env = {
  Bindings: {
    NODE_ENV?: string
    OPENAI_API_KEY?: string
    DEEPSEEK_API_KEY?: string
  }
}

const app = new Hono<Env>()
  .post(
    '/api/profile',
    sValidator(
      'form',
      z.object({
        name: z.string().min(2, { message: 'nameは2文字以上でなければなりません' }),
        email: z.string().email({ message: 'emailは正しい形式ではありません' }),
      }),
      (values, c) => {
        const { success, error = [] } = values as {
          success: boolean
          error?: { message: string }[]
        }
        if (success) {
          return
        }
        return c.json({ error: error.map((x) => x.message).join(',') || '' }, 400)
      },
    ),
    (c) => {
      const { name, email } = c.req.valid('form') // form-data; で受け取る場合
      console.log('req', { name, email })
      return c.json({ name, email, updated_at: new Date().toISOString() })
    },
  )
  .post(
    '/api/chat',
    validator('header', (value, c) => {
      const apiKey = value['api-key']
      const basePath = value['base-path']
      if (!apiKey) {
        return c.json({ message: `Validation Error: Missing required header 'api-key'` }, 400)
      }
      if (!basePath) {
        return c.json({ message: `Validation Error: Missing required header 'base-path'` }, 400)
      }
      if (!z.string().url().safeParse(basePath).success) {
        return c.json({ message: `Validation Error: Invalid url 'base-path'` }, 400)
      }
      return { 'api-key': apiKey, 'base-path': basePath }
    }),
    sValidator(
      'json',
      z.object({
        messages: z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .array(),
        model: z.string().min(1),
        stream: z.boolean().default(false),
        temperature: z.number().min(0).max(1).optional(),
        max_tokens: z.number().min(1).optional(),
        stream_options: z
          .object({
            include_usage: z.boolean().optional(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const header = c.req.valid('header')
      const data = c.req.valid('json')
      try {
        const openai = new OpenAI({
          apiKey: header['api-key'],
          baseURL: header['base-path'],
        })
        const completion = await openai.chat.completions.create({
          messages: data.messages,
          model: data.model,
          stream: data.stream,
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          stream_options: data.stream_options,
        })

        if (!data.stream) {
          return c.json(completion as OpenAI.ChatCompletion)
        }

        return streamSSE(c, async (stream) => {
          let aborted = false
          stream.onAbort(() => {
            aborted = true
            completionStream.controller.abort()
          })
          const completionStream = completion as Stream<OpenAI.ChatCompletionChunk>
          for await (const chunk of completionStream) {
            await stream.writeSSE({ data: JSON.stringify(chunk) })
          }
          if (!aborted) {
            await stream.writeSSE({ data: '[DONE]' })
          }
        })
      } catch (e) {
        console.error(e)
        return c.json({ message: e instanceof Error && e.message }, 500)
      }
    },
  )
  .post(
    '/api/chat_old',
    sValidator(
      'json',
      z.object({
        llm: z.enum(['openai', 'deepseek', 'test'], {
          message: "llmは'openai','deepseek', 'test'のいずれかを指定してください",
        }),
        model: z.string().min(1),
        temperature: z.number().min(0).max(1).nullish(),
        maxTokens: z
          .number()
          .min(1, { message: 'maxTokensは1以上でなければなりません' })
          .max(4096, { message: 'maxTokensは4096以下でなければなりません' })
          .nullish(),
        messages: z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1, { message: 'messagesは1文字以上でなければなりません' }),
          })
          .array(),
      }),
      (values, c) => {
        const { success, error = [] } = values as {
          success: boolean
          error?: { message: string }[]
        }
        if (success) {
          return
        }
        return c.json({ error: error.map((x) => x.message).join(',') || '' }, 400)
      },
    ),
    async (c) => {
      const { llm, model, temperature, maxTokens, messages } = c.req.valid('json')
      const envs = env<{
        OPENAI_API_KEY?: string
        DEEPSEEK_API_KEY?: string
      }>(c)
      const llmProvider = getLLMProvider(llm, envs)
      const reader = await llmProvider.chatStream(model, messages, temperature, maxTokens)

      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      return streamText(c, async (stream) => {
        let aborted = false
        stream.onAbort(() => {
          aborted = true
        })
        while (true) {
          const { done, value } = (await reader.read()) || {}
          if (done || aborted) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n')

          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary).trim()
            buffer = buffer.slice(boundary + 1)
            boundary = buffer.indexOf('\n')

            if (!chunk.startsWith('data:')) {
              continue
            }

            const jsonStr = chunk.slice(5).trim() // 'data:'部分を除去
            if (jsonStr !== '[DONE]') {
              try {
                const { choices, usage } = JSON.parse(jsonStr) as {
                  id: string
                  model: string
                  choices: { delta: { content?: string }; finish_reason?: string }[]
                  usage: {
                    prompt_tokens: number
                    completion_tokens: number
                    total_tokens: number
                  } | null
                }
                const text = choices.at(0)?.delta?.content || ''
                const finishReason = choices.at(0)?.finish_reason || ''

                if (finishReason) {
                  console.log(`finish_reason=${finishReason}`)
                }

                if (usage) {
                  console.log(
                    `prompt_tokens=${usage.prompt_tokens}, completion_tokens=${usage.completion_tokens}`,
                  )
                }

                await stream.writeln(
                  `data: ${JSON.stringify({ content: text, finish_reason: finishReason, usage })}`,
                )
              } catch (error) {
                console.error('Failed to parse JSON:', error)
              }
            }
          }
        }
      })
    },
  )
  .get('*', (c) => {
    const { NODE_ENV } = env<{ NODE_ENV?: string }>(c)
    const prod = NODE_ENV === 'production'
    return c.html(
      renderToString(
        <html lang='ja'>
          <head>
            <meta charSet='utf-8' />
            <meta content='width=device-width, initial-scale=1' name='viewport' />
            <link rel='icon' href='/static/favicon.ico' />
            <link rel='stylesheet' href={prod ? '/static/main.css' : '/src/client/main.css'} />
            <script type='module' src={prod ? '/static/client.js' : '/src/client/main.tsx'} />
          </head>
          <body>
            <div id='root' />
          </body>
        </html>,
      ),
    )
  })
  .onError((err, c) => {
    return c.json({ error: err.message }, 500)
  })

export type AppType = typeof app
export default app
