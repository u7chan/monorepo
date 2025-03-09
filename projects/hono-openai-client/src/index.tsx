import { Hono } from 'hono'
import { validator } from 'hono/validator'
import OpenAI from 'openai'

const app = new Hono()
const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
})

async function chatCompletions(
  input: string
): Promise<{ model: string; content: string }> {
  const completion = await openai.chat.completions.create({
    model: process.env.MODEL || '',
    messages: [
      {
        role: 'user',
        content: input,
      },
    ],
  })
  const { model, choices } = completion
  const { content } = choices[0].message
  return {
    model,
    content: content || '',
  }
}

app.get(
  '/',
  validator('query', async (value, c) => {
    const input = value['input'] as string | undefined
    const completion = input ? await chatCompletions(input) : null
    return c.html(
      <html lang='ja'>
        <head>
          <title>hono-openai-client</title>
        </head>
        <body>
          <form action='/'>
            <div
              style={{
                width: '50vw',
                display: 'flex',
                gap: 8,
              }}
            >
              <textarea
                name='input'
                placeholder='質問してみよう！'
                style={{ flex: 1 }}
              />
              <input type='submit' value='送信' />
            </div>
          </form>
          <div
            style={{
              width: '50vw',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {input && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                }}
              >
                <div
                  style={{
                    display: 'inline-block',
                    whiteSpace: 'pre-wrap',
                    backgroundColor: '#E3F2FD',
                    color: 'black',
                    padding: '10px 15px',
                    borderRadius: '10px',
                  }}
                >
                  {input}
                </div>
              </div>
            )}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-start',
              }}
            >
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  backgroundColor: '#ECEFF1',
                  color: 'black',
                  padding: '10px 15px',
                  borderRadius: '10px',
                }}
              >
                {completion
                  ? completion.content
                  : 'こんにちは！\n何かお手伝いできることはありますか？'}
              </div>
            </div>
          </div>
          {completion && (
            <div
              style={{
                display: 'inline-block',
                backgroundColor: '#ECEFF1',
                marginTop: '8px',
                borderRadius: '8px',
                padding: '4px 10px',
                color: 'black',
                fontSize: '12px',
              }}
            >
              {completion.model}
            </div>
          )}
        </body>
      </html>
    )
  })
)

export default app
