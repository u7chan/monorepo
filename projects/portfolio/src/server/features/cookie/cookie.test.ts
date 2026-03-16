import { afterEach, describe, expect, it, vi } from 'vitest'
import { cookie, parseDurationToSeconds } from './cookie'

describe('parseDurationToSeconds', () => {
  it('日・時間・分・秒を秒に変換する', () => {
    expect(parseDurationToSeconds('1d')).toBe(86400)
    expect(parseDurationToSeconds('2h')).toBe(7200)
    expect(parseDurationToSeconds('30m')).toBe(1800)
    expect(parseDurationToSeconds('45s')).toBe(45)
  })

  it('不正な値は 0 を返す', () => {
    expect(parseDurationToSeconds('')).toBe(0)
    expect(parseDurationToSeconds('10x')).toBe(0)
    expect(parseDurationToSeconds('abc')).toBe(0)
  })
})

describe('cookie.createOptions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cookie 用の options を作成する', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T00:00:00.000Z'))

    const options = cookie.createOptions('1d')

    expect(options).toMatchObject({
      path: '/',
      secure: false,
      httpOnly: true,
      maxAge: 86400,
      sameSite: 'Strict',
    })
    expect(options.expires.toISOString()).toBe('2026-03-17T00:00:00.000Z')
  })
})
