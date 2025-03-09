import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { HTTPException } from 'hono/http-exception'
import { streamText } from 'hono/streaming'
import { validator } from 'hono/validator'
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
          <div>
            <a href='/non-stream' className='underline text-blue-500'>
              非ストリーム版
            </a>
          </div>
          <div>
            <a href='/stream' className='underline text-blue-500'>
              ストリーム版
            </a>
          </div>
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
                ルート
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

export default app
