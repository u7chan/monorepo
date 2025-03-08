import { Hono } from 'hono'
import { validator } from 'hono/validator'

const app = new Hono()

app.get(
  '/',
  validator('query', (value, c) => {
    const input = value['input']
    return c.html(
      <html lang='ja'>
        <head>
          <title>hono-openai-client</title>
        </head>
        <body>
          <form action='/'>
            <input name='input' value={input} />
            <input type='submit' value='Send' />
          </form>
        </body>
      </html>
    )
  })
)

export default app
