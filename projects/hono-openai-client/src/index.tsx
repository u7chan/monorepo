import { Hono } from 'hono'
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
      await chatCompletionsStream(input, async (text) => {
        await stream.write(text)
      })
    })
  }
)

app.get('/stream', (c) => {
  return c.html(`
    <html lang='ja'>
      <head>
        <title>hono-openai-client</title>
      </head>
      <body>
        <div style="display:flex;gap:8px;align-items:end;">
          <div>
            <textarea id="input" placeholder='質問してみよう！'></textarea>
          </div>
          <div>
            <button id="send">送信</button>
          </div>
        </div>
        <div id="message" style="white-space: pre-wrap;"></div>
        <script>
          document.querySelector("#send").addEventListener("click", async () => {
            const messageElement = document.querySelector('#message');
            messageElement.textContent = '';
            const input = document.querySelector("#input").value;
            try {
              const res = await fetch("/api/stream", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ input }),
              })
              if (!res.ok) {
                  throw new Error('Network response was not ok');
                }
              const reader = res.body.getReader();
              const decoder = new TextDecoder('utf-8');
              let done = false;
              while (!done) {
                  const { done: isDone, value } = await reader.read();
                  done = isDone;
                  if (value) {
                      const chunk = decoder.decode(value, { stream: !done });
                      messageElement.textContent += chunk;
                  }
              }
            } catch (error) {
              console.error('Error:', error);
              alert("エラーが発生しました");
            }
          });
        </script>
      </body>
    </html>
    `)
})

export default app
