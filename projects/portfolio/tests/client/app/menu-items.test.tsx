import { describe, expect, it } from 'vitest'
import { buildMenuItems } from '#/client/app/menu-items'

const labels = (isSignedIn: boolean) => buildMenuItems({ isSignedIn }).map(({ label }) => label)

describe('buildMenuItems', () => {
  it('未ログインではチャット系の項目を出さない', () => {
    expect(labels(false)).not.toContain('Chat')
    expect(labels(false)).not.toContain('Compare')
  })

  it('ログイン済みではチャット系の項目を出す', () => {
    expect(labels(true)).toContain('Chat')
    expect(labels(true)).toContain('Compare')
  })

  it('ログイン状態にかかわらず公開ページの項目は残す', () => {
    for (const isSignedIn of [false, true]) {
      expect(labels(isSignedIn)).toEqual(expect.arrayContaining(['Home', 'About', 'Diff']))
    }
  })
})
