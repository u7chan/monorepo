import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose"

import { ISSUER } from "../../src/siwc/constants"

export type TestIdp = {
  jwks: JSONWebKeySet
  signIdToken: (options: {
    audience: string
    nonce: string
    subject?: string
    email?: string | null
    issuer?: string
    expiresInSeconds?: number
  }) => Promise<string>
}

/** テスト用のローカル ID プロバイダ（JWKS と ID トークン署名）。 */
export async function createTestIdp(): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  }

  return {
    jwks: { keys: [jwk] },
    async signIdToken(options) {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const payload: Record<string, unknown> = { nonce: options.nonce }
      if (options.email !== null && options.email !== undefined) {
        payload.email = options.email
      }
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience)
        .setSubject(options.subject ?? "subject-1")
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + (options.expiresInSeconds ?? 600))
        .sign(privateKey)
    },
  }
}
