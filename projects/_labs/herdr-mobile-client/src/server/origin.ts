// 受け付ける形は Issue の指定どおりに固定する（#pair= を付けた URL をそのまま QR にするため、
// http のホストとポート以外は受け付けない）。
const PAIR_ORIGIN_PATTERN = /^http:\/\/[0-9A-Za-z.\-]+:[0-9]{1,5}$/

export function isPairOrigin(value: unknown): value is string {
  return typeof value === "string" && PAIR_ORIGIN_PATTERN.test(value)
}

export function pairOriginFromBody(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const origin = (value as { origin?: unknown }).origin

  return isPairOrigin(origin) ? origin : null
}

export function pairUrl(origin: string, code: string): string {
  return `${origin}/#pair=${code}`
}
