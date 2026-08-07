// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatbotIcon } from '#/client/shared/icons/chatbot-icon'

describe('ChatbotIcon', () => {
  it('レンダリングされること', () => {
    const { container } = render(<ChatbotIcon />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
  })

  it('label 指定時は aria-label が設定される', () => {
    const { container } = render(<ChatbotIcon label='チャットボット' />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-label')).toBe('チャットボット')
  })

  it('className が SVG 要素に適用される', () => {
    const { container } = render(<ChatbotIcon className='text-green-500' />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('class')).toContain('text-green-500')
  })
})
