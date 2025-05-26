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
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

    // ストリームが中断された時の処理
    stream.onAbort(() => {
      console.log('Stream aborted, cleaning up resources...')

      // readerが存在する場合はキャンセル
      if (reader) {
        reader.cancel().catch((e) => {
          console.warn('Reader cancel error:', e)
        })
      }

      // fetchリクエストを中断
      if (!controller.signal.aborted) {
        controller.abort()
      }
    })

    try {
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

      reader = res.body?.getReader() ?? null
      if (!reader) {
        console.warn('No reader available from response body.')
        return
      }

      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        // 中断シグナルをチェック
        if (controller.signal.aborted) {
          console.log('Request was aborted, stopping stream processing')
          break
        }

        const { done, value } = await reader.read()
        if (done) break

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
    } catch (error) {
      // AbortErrorは正常な中断なのでログレベルを下げる
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Fetch request was aborted')
      } else {
        console.error('Fetch error:', error)
        stream.writeln(
          `リクエストエラーが発生しました: ${error instanceof Error ? error.message : 'Unknown error'}`,
        )
      }
    } finally {
      // リソースのクリーンアップ
      if (reader) {
        try {
          await reader.cancel()
        } catch (e) {
          console.warn('Reader cleanup error:', e)
        }
      }
    }
  })
})

app.get('/', (c) => {
  return c.render(<div id='root' />)
})

export default app
