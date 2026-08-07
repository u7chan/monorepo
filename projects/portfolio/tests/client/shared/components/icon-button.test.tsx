// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { IconButton } from '#/client/shared/components/icon-button/icon-button'

describe('IconButton', () => {
  afterEach(() => {
    cleanup()
  })
  describe('label', () => {
    it('必須labelがaria-labelとして設定される', () => {
      render(
        <IconButton label='メニューを開く'>
          <span data-testid='icon' />
        </IconButton>
      )
      expect(screen.getByRole('button', { name: 'メニューを開く' })).toBeTruthy()
    })
  })

  describe('type', () => {
    it('未指定時はデフォルトでtype=buttonになる', () => {
      render(
        <IconButton label='test'>
          <span />
        </IconButton>
      )
      const button = screen.getByRole('button')
      expect(button.getAttribute('type')).toBe('button')
    })

    it('明示的にtype=submitを指定できる', () => {
      render(
        <IconButton label='test' type='submit'>
          <span />
        </IconButton>
      )
      const button = screen.getByRole('button')
      expect(button.getAttribute('type')).toBe('submit')
    })
  })

  describe('props forwarding', () => {
    it('disabledが正しく伝播する', () => {
      render(
        <IconButton label='test' disabled>
          <span />
        </IconButton>
      )
      const button = screen.getByRole('button') as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })

    it('classNameが正しく伝播する', () => {
      render(
        <IconButton label='test' className='custom-class'>
          <span />
        </IconButton>
      )
      const button = screen.getByRole('button')
      expect(button.className).toContain('custom-class')
    })

    it('標準button propsがforwardされる', () => {
      render(
        <IconButton label='test' data-testid='icon-btn' onClick={() => {}}>
          <span />
        </IconButton>
      )
      const button = screen.getByTestId('icon-btn')
      expect(button).toBeTruthy()
      expect(button.tagName).toBe('BUTTON')
    })
  })
})
