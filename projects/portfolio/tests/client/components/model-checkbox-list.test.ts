import { describe, expect, it } from 'vitest'
import { groupModelsByProvider } from '#/client/components/chat-compare/model-checkbox-list'

describe('groupModelsByProvider', () => {
  it('provider ごとにモデルを分類し、表示名から provider を省く', () => {
    expect(groupModelsByProvider(['anthropic/claude-sonnet-4-6', 'openai/gpt-5.2', 'openai/gpt-5.4-mini'])).toEqual([
      {
        provider: 'anthropic',
        models: [{ id: 'anthropic/claude-sonnet-4-6', label: 'claude-sonnet-4-6' }],
      },
      {
        provider: 'openai',
        models: [
          { id: 'openai/gpt-5.2', label: 'gpt-5.2' },
          { id: 'openai/gpt-5.4-mini', label: 'gpt-5.4-mini' },
        ],
      },
    ])
  })

  it('provider と model に分割できない場合はその他に分類する', () => {
    expect(groupModelsByProvider(['gpt-5.2', 'openai/', '/gpt-5.4'])).toEqual([
      {
        provider: 'その他',
        models: [
          { id: 'gpt-5.2', label: 'gpt-5.2' },
          { id: 'openai/', label: 'openai/' },
          { id: '/gpt-5.4', label: '/gpt-5.4' },
        ],
      },
    ])
  })
})
