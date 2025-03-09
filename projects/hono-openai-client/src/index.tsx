import { Hono } from 'hono'
import { validator } from 'hono/validator'
import OpenAI from 'openai'

const app = new Hono()

async function chatCompletions(
  input: string
): Promise<{ model: string; content: string }> {
  const openai = new OpenAI({
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  })
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
          <script src='https://unpkg.com/@tailwindcss/browser@4'></script>
        </head>
        <body className='flex flex-col gap-2 p-2'>
          <form action='/'>
            <div className='flex gap-2 w-[50vw]'>
              <textarea
                name='input'
                placeholder='質問してみよう！'
                className='flex-1 border rounded-md p-2'
              />
              <input
                type='submit'
                value='送信'
                className='bg-blue-500 text-white rounded-md px-4 py-2 cursor-pointer'
              />
            </div>
          </form>

          <div className='flex flex-col gap-2 w-[50vw]'>
            {input && (
              <div className='flex justify-end'>
                <div className='inline-block bg-blue-100 text-black p-2 rounded-lg whitespace-pre-wrap'>
                  {input}
                </div>
              </div>
            )}
            <div className='flex flex-col gap-1'>
              <div className='flex justify-start'>
                <div className='bg-gray-200 text-black p-2 rounded-lg whitespace-pre-wrap'>
                  {completion
                    ? completion.content
                    : 'こんにちは！\n何かお手伝いできることはありますか？'}
                </div>
              </div>
              {completion && (
                <div className='flex'>
                  <div className='bg-gray-200 rounded-md px-2 py-1 text-black text-sm'>
                    {completion.model}
                  </div>
                </div>
              )}
            </div>
          </div>
        </body>
      </html>
    )
  })
)

export default app
