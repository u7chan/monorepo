import { describe, expect, test } from 'vitest'
import app from '#/server/app'

describe('App', () => {
  test('POST /api/chat', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toStrictEqual('Hello from API!')
  })

  test('GET /', async () => {
    const res = await app.request('/', {
      method: 'GET',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root"></div>')
  })
})
