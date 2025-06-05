import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { logger } from 'hono/logger'
import { streamText } from 'hono/streaming'
import z from 'zod'
import type { Env } from '#/server/env'
import { renderer } from '#/server/renderer'

const app = new Hono<Env>()
  .use(logger())
  .use('/static/*', serveStatic({ root: './dist' }))
  .use(renderer)
  .post(
    '/api/chat',
    zValidator(
      'json',
      z.object({
        messages: z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          })
          .array(),
      }),
    ),
    async (c) => {
      const req = c.req.valid('json')
      console.debug('req: ', req)
      const envs = env(c)

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
          const res = await fetch(envs.CHAT_BASE_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${envs.CHAT_BASE_URL}`,
            },
            body: JSON.stringify({
              model: 'gpt-4.1-nano',
              messages: req.messages,
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
    },
  )
  .get('/', (c) => {
    return c.render(<div id='root' />)
  })

export type AppType = typeof app
export default app
