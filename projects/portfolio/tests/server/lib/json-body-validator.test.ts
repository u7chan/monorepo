import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonBodyValidator } from '#/server/lib/json-body-validator'

const schema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
})

const app = new Hono().post('/chat', jsonBodyValidator(schema), (c) => c.json({ ok: true }))

const post = (body: unknown) =>
  app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('jsonBodyValidator', () => {
  it('スキーマ違反の項目名を公開エラー形式の message に載せる', async () => {
    const res = await post({ model: '', messages: [] })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      code: 'VALIDATION_ERROR',
      message: "Invalid request body 'model'",
      retryable: false,
    })
  })

  it('ネストした項目はドット区切りのパスで示す', async () => {
    const res = await post({ model: 'model-a', messages: [{ role: 'user' }] })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      code: 'VALIDATION_ERROR',
      message: "Invalid request body 'messages.0.content'",
      retryable: false,
    })
  })

  it('スキーマを満たすボディはそのまま後続ハンドラへ渡す', async () => {
    const res = await post({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })
})
