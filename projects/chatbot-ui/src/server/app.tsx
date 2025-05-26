import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { streamText } from 'hono/streaming'

import { env } from 'hono/adapter'
import type { Env } from '#/server/env'
import { renderer } from '#/server/renderer'

const app = new Hono<Env>()
app.use(logger())
app.use('/static/*', serveStatic({ root: './dist' }))
app.use(renderer)

app.post('/api/chat', async (c) => {
  const { message } = await c.req.json()
  const { CHAT_BASE_URL } = env(c)

  return streamText(c, async (stream) => {
    const controller = new AbortController()

    let aborted = false
    stream.onAbort(() => {
      console.log('Stream aborted, aborting fetch request...')
      // controller?.abort()
      aborted = true
    })

    const res = await fetch(CHAT_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        model: 'dummy-model',
        stream: true,
      }),
      signal: controller.signal,
    })
    console.log('Response status:', res.status, res.statusText)
    if (!res.ok) {
      const text = await res.text()
      stream.writeln(`APIからの応答に失敗しました: ${text}`)
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      console.warn('No reader available from response body.')
      return
    }

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (aborted) break

      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const idx = buffer.indexOf('\n')
        if (idx === -1) break

        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data: ')) continue

        const jsonStr = line.replace(/^data:\s*/, '')
        if (jsonStr === '[DONE]') {
          console.log('Stream completed.')
          return
        }
        try {
          const parsedChunk = JSON.parse(jsonStr)
          const content = parsedChunk.choices[0]?.delta?.content
          if (content) {
            stream.write(content)
          }
        } catch (e) {
          console.error('JSON parse error:', e)
        }
      }
    }

    // stream.writeln('こん\nにちは！')
    // await delay(1000)
    // stream.writeln(`「${message}」とご質問ありがとうございます。`)
    // await delay(1000)
    // stream.writeln('お待たせしました！')
    // await delay(1000)
    // stream.writeln('どのようにお手伝いできますか？')
    // console.log('Streamed response:', { message })
  })
})

app.get('/', (c) => {
  return c.render(<div id='root' />)
})

export default app
