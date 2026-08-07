// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatbotTypingIcon } from '#/client/shared/icons/chatbot-typing-icon'

describe('ChatbotTypingIcon', () => {
  describe('SVG 公開props', () => {
    it('レンダリングされること', () => {
      const { container } = render(<ChatbotTypingIcon />)
      const svg = container.querySelector('svg')
      expect(svg).toBeTruthy()
    })

    it('label 未指定時は aria-hidden が設定される', () => {
      const { container } = render(<ChatbotTypingIcon />)
      const svg = container.querySelector('svg')
      expect(svg?.getAttribute('aria-hidden')).toBe('true')
    })

    it('className が SVG 要素に適用される', () => {
      const { container } = render(<ChatbotTypingIcon className='text-blue-500' />)
      const svg = container.querySelector('svg')
      expect(svg?.getAttribute('class')).toContain('text-blue-500')
    })
  })

  describe('CSS', () => {
    it('prefers-reduced-motion の無効化が含まれる', () => {
      const css = readFileSync(
        resolve(import.meta.dirname, '../../../../src/client/shared/icons/chatbot-typing-icon.css'),
        'utf-8'
      )
      expect(css).toContain('@media (prefers-reduced-motion: reduce)')
      expect(css).toContain('animation: none')
    })
  })
})
