import { cookie, formatDurationLabel, parseDurationToSeconds } from '#/server/features/cookie/cookie'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('formatDurationLabel', () => {
  it('日・時間・分・秒を日本語の表示へ変換する', () => {
    expect(formatDurationLabel('1d')).toBe('1日')
    expect(formatDurationLabel('2h')).toBe('2時間')
    expect(formatDurationLabel('30m')).toBe('30分')
    expect(formatDurationLabel('45s')).toBe('45秒')
  })

  it('不正な値は null を返す', () => {
    expect(formatDurationLabel('')).toBeNull()
    expect(formatDurationLabel('10x')).toBeNull()
    expect(formatDurationLabel('abc')).toBeNull()
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
