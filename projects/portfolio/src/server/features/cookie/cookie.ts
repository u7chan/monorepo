interface CookieOptions {
  path: string
  secure: boolean
  httpOnly: boolean
  maxAge: number
  expires: Date
  sameSite: 'Strict' | 'Lax' | 'None'
}

interface Cookie {
  createOptions(duration: string): CookieOptions
}
export const cookie: Cookie = {
  createOptions(duration: string): CookieOptions {
    const cookieExpiresSec = parseDurationToSeconds(duration)
    return {
      path: '/',
      secure: false, // httpのため
      httpOnly: true,
      maxAge: cookieExpiresSec,
      expires: new Date(Date.now() + cookieExpiresSec),
      sameSite: 'Strict',
    }
  },
}

/**
 * 期間を表す文字列（例: '1d', '12h', '30m', '10s'）を受け取り、秒に変換して返します。
 *
 * サポートする単位:
 * - d: 日 (day)
 * - h: 時間 (hour)
 * - m: 分 (minute)
 * - s: 秒 (second)
 *
 * @param duration - 変換対象の期間を表す文字列（数値と単位のみ、例: '1d'）
 * @returns 変換した秒数。引数が無効な場合は 0 を返す
 *
 * 例: '1d' → 86400 (秒)
 *     '12h' → 43200
 *     '30m' → 1800
 *     '10s' → 10
 */
export function parseDurationToSeconds(duration: string): number {
  if (!duration || typeof duration !== 'string') return 0

  const regex = /^(\d+)(d|h|m|s)$/i
  const match = duration.match(regex)
  if (!match) return 0

  const value = Number(match[1])
  const unit = match[2].toLowerCase()

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60
    case 'h':
      return value * 60 * 60
    case 'm':
      return value * 60
    case 's':
      return value
    default:
      return 0
  }
}
