// @vitest-environment jsdom

import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { requireSignedIn } from '#/client/app/require-signed-in'

const setMetaProps = (props: Record<string, unknown>) => {
  document.head.innerHTML = ''
  const meta = document.createElement('meta')
  meta.name = 'props'
  meta.content = JSON.stringify(props)
  document.head.append(meta)
}

describe('requireSignedIn', () => {
  it('未ログインでは Home へ redirect する', () => {
    setMetaProps({ email: null })

    try {
      requireSignedIn()
    } catch (error) {
      expect(isRedirect(error)).toBe(true)
      expect((error as { options: { to: string } }).options.to).toBe('/')
      return
    }

    throw new Error('redirect されなかった')
  })

  it('ログイン済みなら素通りする', () => {
    setMetaProps({ email: 'test@example.com' })

    expect(() => requireSignedIn()).not.toThrow()
  })
})
