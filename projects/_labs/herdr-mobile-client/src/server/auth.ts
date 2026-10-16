import { constantTimeEquals } from "./constant-time"

const SCHEME = "bearer"

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
