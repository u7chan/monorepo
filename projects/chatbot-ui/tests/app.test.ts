import app from '@/server/app'
import { describe, expect, test } from 'vitest'

describe('App', () => {
  test('GET /api/health', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ status: 'OK' })
  })
})
