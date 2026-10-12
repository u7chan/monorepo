import {
  createRemoteJWKSet,
  customFetch,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose"

import type { FetchLike } from "./fetch"

export type VerifiedIdentity = {
  subject: string
  email: string | null
  name: string | null
}

export type IdentityVerification = {
  issuer: string
  /** 発行された client_id。ID トークンの aud と一致することを要求する。 */
  audience: string
  nonce: string
  keyResolver: JWTVerifyGetKey
  now?: () => Date
}

export function createRemoteKeyResolver(
  jwksUri: string,
  fetchImpl?: FetchLike,
): JWTVerifyGetKey {
  // テストではモックした fetch で JWKS を返すため、jose 内部の fetch を差し替える
  return createRemoteJWKSet(
    new URL(jwksUri),
    fetchImpl === undefined
      ? undefined
      : { [customFetch]: fetchImpl as typeof fetch },
  )
}

export async function verifyIdToken(
  verification: IdentityVerification,
  idToken: string,
): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(idToken, verification.keyResolver, {
    issuer: verification.issuer,
    audience: verification.audience,
    requiredClaims: ["sub", "exp", "iat"],
    clockTolerance: 5,
    ...(verification.now === undefined
      ? {}
      : { currentDate: verification.now() }),
  })

  if (payload.nonce !== verification.nonce) {
    throw new Error("ID トークンの nonce が一致しません。")
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("ID トークンに sub がありません。")
  }

  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
  }
}
