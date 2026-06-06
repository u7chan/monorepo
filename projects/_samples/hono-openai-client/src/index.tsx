import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { sValidator } from '@hono/standard-validator'
import { HTTPException } from 'hono/http-exception'
import { streamSSE, streamText } from 'hono/streaming'
import { validator } from 'hono/validator'
import { z } from 'zod'
import { ChatUI } from './ChatUI'
import { chatCompletions, chatCompletionsStream } from './chatCompletions'

const app = new Hono()

app.get('/', (c) => {
  return c.html(
    <html lang='ja'>
      <head>
        <title>hono-openai-client</title>
        <script src='https://unpkg.com/@tailwindcss/browser@4' />
      </head>
      <body>
        <div className='container mx-auto px-4'>
          <p className='text-2xl font-semibold py-2'>サンプル</p>
          <hr className='h-px my-2 bg-gray-200 border-0 dark:bg-gray-700' />
          <ul className='list-disc pl-4'>
            <li className='my-2'>
              <a href='/non-stream' className='underline text-blue-500'>
                非ストリーム版
              </a>
            </li>
            <li className='my-2'>
              <a href='/stream' className='underline text-blue-500'>
                ストリーム版
              </a>
            </li>
          </ul>
        </div>
      </body>
    </html>
  )
})

app.get(
  '/non-stream',
  validator('query', async (value, c) => {
    const input = value['input'] as string | undefined
    const completion = input ? await chatCompletions(input) : undefined
    return c.html(
      <html lang='ja'>
        <head>
          <title>hono-openai-client</title>
          <script src='https://unpkg.com/@tailwindcss/browser@4'></script>
        </head>
        <body>
          <div className='container mx-auto px-4'>
            <div className='py-4'>
              <a href='/' className='underline text-blue-500'>
                サンプル
              </a>
              <span className='px-2'>{'>'}</span>
              <span>非ストリーム版</span>
            </div>
            <ChatUI
              endpoint='/non-stream'
              input={input}
              completion={completion}
            />
          </div>
        </body>
      </html>
    )
  })
)

app.get('/stream', serveStatic({ path: './src/stream.html' }))

app.post(
  '/api/stream',
  validator('json', (value) => {
    const input = value['input']
    if (!input) {
      throw new HTTPException(400, { message: 'input is required' })
    }
    return { input }
  }),
  (c) => {
    const { input } = c.req.valid('json')
    return streamText(c, async (stream) => {
      await chatCompletionsStream(input, async (chunk) => {
        await stream.writeln(JSON.stringify(chunk))
      })
    })
  }
)

const chatCompletionsSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })
  ),
  temperature: z.number().min(0).max(1).default(1),
  stream: z.boolean().default(false),
  stream_options: z
    .object({
      include_usage: z.boolean().default(false),
    })
    .optional(),
})

app.post(
  '/api/chat/completions',
  sValidator('json', chatCompletionsSchema),
  (c) => {
    const {
      model: inputModel,
      messages,
      stream,
      stream_options,
    } = c.req.valid('json')
    const id = Array.from({ length: 30 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62)
      )
    ).join('')
    const created = Math.floor(Date.now() / 1000)
    const model = `${inputModel}-${new Date().toISOString().split('T')[0]}`
    const content = `This is fake response,\nHow may I assist you today?\n${messages[0].content}🤖`
    const usage = stream_options?.include_usage
      ? {
          prompt_tokens: 10,
          completion_tokens: 18,
          total_tokens: 28,
        }
      : undefined
    if (!stream) {
      return c.json({
        id,
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
            },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        usage,
      })
    }
    return streamSSE(c, async (stream) => {
      const chunk = {
        id,
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: stream_options?.include_usage ? null : undefined,
      }
      for (const char of content) {
        await stream.writeSSE({
          data: JSON.stringify({
            ...chunk,
            choices: [{ ...chunk.choices[0], delta: { content: char } }],
          }),
        })
        await stream.sleep(50)
      }
      await stream.writeSSE({
        data: JSON.stringify({
          ...chunk,
          choices: [{ ...chunk.choices[0], delta: {}, finish_reason: 'stop' }],
          usage: stream_options?.include_usage ? usage : undefined,
        }),
      })
      await stream.writeSSE({ data: '[DONE]' })
    })
  }
)

export default app
