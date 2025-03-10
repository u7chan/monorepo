import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { sValidator } from '@hono/standard-validator'
import { HTTPException } from 'hono/http-exception'
import { streamText } from 'hono/streaming'
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
})

app.post(
  '/api/chat/completions',
  sValidator('json', chatCompletionsSchema),
  (c) => {
    const { model, messages, stream } = c.req.valid('json')
    if (!stream) {
      return c.json({
        id: Array.from({ length: 30 }, () =>
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
            Math.floor(Math.random() * 62)
          )
        ).join(''),
        created: Math.floor(Date.now() / 1000),
        model: `${model}-${new Date().toISOString().split('T')[0]}`,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `This is fake response,\nHow may I assist you today?\n${messages[0].content}🤖`,
            },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
          total_tokens: 12,
        },
      })
    }
    return c.json({}) // TODO
  }
)

export default app
