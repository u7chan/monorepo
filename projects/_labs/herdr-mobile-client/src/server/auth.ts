import { createHash, timingSafeEqual } from "node:crypto"

const SCHEME = "bearer"

// 長さの違う Buffer を timingSafeEqual へ渡すと例外になるため、固定長のハッシュへ揃えてから比較する。
// 長さの差を比較の分岐に出さないための選択でもある。
function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest()
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest()

  return timingSafeEqual(presentedDigest, expectedDigest)
}

export function extractBearerToken(header: string | null | undefined): string | null {
  if (header === null || header === undefined) {
    return null
  }

  const [scheme, token, ...rest] = header.trim().split(/\s+/)

  if (scheme?.toLowerCase() !== SCHEME || token === undefined || rest.length > 0) {
    return null
  }

  return token
}

export function isAuthorized(header: string | null | undefined, expectedToken: string): boolean {
  const token = extractBearerToken(header)

  if (token === null) {
    return false
  }

  return constantTimeEquals(token, expectedToken)
}
