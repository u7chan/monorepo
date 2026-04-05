import { describe, expect, it, vi } from 'vitest'
import { chatStub } from '#/server/features/chat-stub/chat-stub'

describe('chatStub.completions', () => {
  it('completion の形で content を返す', async () => {
    const result = await chatStub.completions('gpt-test', 'stub content')

    expect(result.model).toBe('gpt-test')
    expect(result.choices[0]?.message.content).toBe('stub content')
  })
})

describe('chatStub.streamCompletions', () => {
  it('chunk を順番に流し最後に usage を含む stop chunk を返す', async () => {
    const onChunk = vi.fn().mockResolvedValue(false)

    await chatStub.streamCompletions({
      model: 'gpt-test',
      reasoningContent: 'thinking',
      content: 'answer',
      includeUsage: true,
      onChunk,
    })

    const chunks = onChunk.mock.calls.map(([chunk]) => chunk)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    })
  })

  it('maxTokens 指定時は length 終了を返す', async () => {
    const onChunk = vi.fn().mockResolvedValue(false)

    await chatStub.streamCompletions({
      model: 'gpt-test',
      reasoningContent: 'thinking',
      content: 'answer',
      maxTokens: 1,
      onChunk,
    })

    const firstChunk = onChunk.mock.calls[0]?.[0]
    expect(firstChunk?.choices[0]?.finish_reason).toBe('length')
  })
})
