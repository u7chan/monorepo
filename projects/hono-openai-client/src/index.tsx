import { Hono } from 'hono'
import { validator } from 'hono/validator'
import OpenAI from 'openai'

const app = new Hono()
const openai = new OpenAI()

async function chatCompletions(input: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: input,
      },
    ],
  })
  const { content } = completion.choices[0].message
  return content || ''
}

app.get(
  '/',
  validator('query', async (value, c) => {
    const input = value['input'] as string | undefined
    const message = input ? chatCompletions(input) : ''
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
          {message && <p>{message}</p>}
        </body>
      </html>
    )
  })
)

export default app
