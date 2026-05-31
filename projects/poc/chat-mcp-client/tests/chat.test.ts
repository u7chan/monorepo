import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import app from '../src/index'
import { chatRequestSchema } from '../src/schemas/chat'

describe('Chat API', () => {
  describe('POST /api/chat/completions', () => {
    const validBody = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
    }

    it('should return 400 when messages is empty', async () => {
      const res = await app.request('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when content is empty', async () => {
      const res = await app.request('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '' }] }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when role is invalid', async () => {
      const res = await app.request('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'invalid', content: 'test' }] }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when temperature is out of range', async () => {
      const res = await app.request('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, temperature: 2 }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when maxTokens is less than 1', async () => {
      const res = await app.request('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, maxTokens: 0 }),
      })
      expect(res.status).toBe(400)
    })

    it('should return 400 when body is not JSON', async () => {
      const res = await app.request('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })
})

describe('chatRequestSchema', () => {
  it('should validate valid request', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'Hello' }],
    })
    expect(result.success).toBe(true)
  })

  it('should validate request with all fields', () => {
    const result = chatRequestSchema.safeParse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      maxTokens: 100,
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty messages', () => {
    const result = chatRequestSchema.safeParse({ messages: [] })
    expect(result.success).toBe(false)
  })

  it('should reject invalid role', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'invalid', content: 'test' }],
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty content', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'user', content: '' }],
    })
    expect(result.success).toBe(false)
  })

  it('should reject temperature above 1', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'test' }],
      temperature: 1.5,
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative temperature', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'test' }],
      temperature: -0.1,
    })
    expect(result.success).toBe(false)
  })

  it('should reject maxTokens less than 1', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 0,
    })
    expect(result.success).toBe(false)
  })

  it('should accept all valid roles', () => {
    const roles = ['user', 'assistant', 'system'] as const
    for (const role of roles) {
      const result = chatRequestSchema.safeParse({
        messages: [{ role, content: 'test' }],
      })
      expect(result.success).toBe(true)
    }
  })
})
