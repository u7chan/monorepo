import { randomBytes } from "node:crypto"
import { constantTimeEquals } from "./constant-time"

// 8 バイトを base64url にすると常に 11 文字になる。長くすると QR が大きくなり、端末で読み取れなくなる。
export const PAIR_CODE_LENGTH = 11
export const PAIR_TTL_MS = 60_000
export const PAIR_ATTEMPT_LIMIT = 10
export const PAIR_ATTEMPT_WINDOW_MS = 60_000

const PAIR_CODE_PATTERN = /^[A-Za-z0-9_-]+$/

export type IssuedPairCode = {
  code: string
  expiresAt: string
}

export type Pairing = {
  issue: () => IssuedPairCode
  registerAttempt: () => boolean
  consume: (code: string) => boolean
}

export type PairingOptions = {
  now?: () => number
  generateCode?: () => string
}

export function isPairCodeFormat(value: unknown): value is string {
  return typeof value === "string" && value.length === PAIR_CODE_LENGTH && PAIR_CODE_PATTERN.test(value)
}

export function pairCodeFromBody(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const code = (value as { code?: unknown }).code

  return isPairCodeFormat(code) ? code : null
}

export function generatePairCode(): string {
  return randomBytes(8).toString("base64url")
}

export function createPairing(options: PairingOptions = {}): Pairing {
  const now = options.now ?? Date.now
  const generateCode = options.generateCode ?? generatePairCode
  const attempts: number[] = []
  let active: { code: string; expiresAt: number } | null = null

  function registerAttempt(): boolean {
    const current = now()

    while (attempts.length > 0 && current - attempts[0]! >= PAIR_ATTEMPT_WINDOW_MS) {
      attempts.shift()
    }

    if (attempts.length >= PAIR_ATTEMPT_LIMIT) {
      return false
    }

    attempts.push(current)

    return true
  }

  function issue(): IssuedPairCode {
    const expiresAt = now() + PAIR_TTL_MS
    const code = generateCode()

    // 有効なコードは 1 件だけ持つ。古い QR を有効にしたままにしないため、再発行で置き換える。
    active = { code, expiresAt }

    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  function consume(code: string): boolean {
    const entry = active

    if (entry === null || !constantTimeEquals(code, entry.code)) {
      return false
    }

    active = null

    return now() < entry.expiresAt
  }

  return { issue, registerAttempt, consume }
}
