// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatbotTypingIcon } from '#/client/shared/icons/chatbot-typing-icon'

describe('ChatbotTypingIcon', () => {
  it('prefers-reduced-motion 時にアニメーションを無効化する', () => {
    const { container } = render(<ChatbotTypingIcon />)
    const style = container.querySelector('style')?.textContent ?? ''
    expect(style).toContain('@media (prefers-reduced-motion: reduce)')
    expect(style).toContain('animation: none')
  })
})
