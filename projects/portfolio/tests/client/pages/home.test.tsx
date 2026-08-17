// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('hono/client', () => ({
  hc: () => ({
    api: {
      signin: {
        $post: vi.fn(),
      },
      signout: {
        $post: vi.fn(),
      },
    },
  }),
}))

import { Home } from '#/client/features/home/page'

describe('Home page', () => {
  afterEach(() => {
    cleanup()
  })

  it('ログイン済みの場合はログイン有効期限を表示する', () => {
    document.head.innerHTML = ''
    const meta = document.createElement('meta')
    meta.name = 'props'
    meta.content = JSON.stringify({
      email: 'test@example.com',
      loginExpiresLabel: '1日',
    })
    document.head.append(meta)

    const { container } = render(<Home />)

    expect(container.textContent).toContain('test@example.com')
    expect(container.textContent).toContain('ログイン有効期限：1日')
  })

  it('未ログインの場合もログインフォームとシステム状態ウィジェットを表示する', () => {
    document.head.innerHTML = ''

    render(<Home />)

    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'システム状態' })).toBeTruthy()
  })
})
