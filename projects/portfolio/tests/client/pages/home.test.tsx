// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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

import { Home } from '#/client/pages/home'

describe('Home page', () => {
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
})
