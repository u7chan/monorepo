import { Hono } from 'hono'
import OpenAI from 'openai'

export async function chat(model: string, query: string): Promise<string> {
  const openai = new OpenAI({
    apiKey: process.env.LITELLM_API_BASE_URL || '',
    baseURL: process.env.LITELLM_API_KEY || '',
  })
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'あなたは優秀なAIエージェントです。必ず`plain/text`形式の日本語で回答してください。',
      },
      {
        role: 'user',
        content: query,
      },
    ],
  })
  return response.choices[0].message.content || ''
}

const app = new Hono()

app.post('/chat', async (c) => {
  const { model, query } = await c.req.json()
  const message = await chat(model, query)
  return c.json({ message })
})

app.get('/', (c) => c.html(Bun.file('src/index.html').text()))

export default app
