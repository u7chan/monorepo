import { describe, expect, test } from 'vitest'
import app from '#/server/app'

describe('App', () => {
  test('GET /api/health', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ status: 'OK' })
  })
})
