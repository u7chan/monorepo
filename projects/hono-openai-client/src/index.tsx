import { Hono } from 'hono'
import { validator } from 'hono/validator'
import { ChatUI } from './ChatUI'
import { chatCompletions } from './chatCompletions'

const app = new Hono()

app.get(
  '/',
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
          <ChatUI input={input} completion={completion} />
        </body>
      </html>
    )
  })
)

export default app
