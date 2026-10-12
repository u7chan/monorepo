import { describe, expect, test } from "bun:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"

import { ISSUER } from "../src/siwc/constants"
import { verifyIdToken } from "../src/siwc/identity"

const { publicKey, privateKey } = await generateKeyPair("RS256")
const keyResolver = createLocalJWKSet({
  keys: [
    {
      ...(await exportJWK(publicKey)),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    },
  ],
})

type SignOptions = {
  issuer?: string
  audience?: string
  nonce?: string
  expiresInSeconds?: number
  subject?: string
}

async function signIdToken(options: SignOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return new SignJWT({
    nonce: options.nonce ?? "expected-nonce",
    email: "user@example.com",
    name: "Test User",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "oaiapp_example")
    .setSubject(options.subject ?? "subject-1")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + (options.expiresInSeconds ?? 3600))
    .sign(privateKey)
}

describe("verifyIdToken", () => {
  test("正しい ID トークンから identity を取り出す", async () => {
    const identity = await verifyIdToken(
      {
        issuer: ISSUER,
        audience: "oaiapp_example",
        nonce: "expected-nonce",
        keyResolver,
      },
      await signIdToken(),
    )

    expect(identity).toEqual({
      subject: "subject-1",
      email: "user@example.com",
      name: "Test User",
    })
  })

  test("nonce が一致しなければ拒否する", async () => {
    await expect(
      verifyIdToken(
        {
          issuer: ISSUER,
          audience: "oaiapp_example",
          nonce: "different-nonce",
          keyResolver,
        },
        await signIdToken(),
      ),
    ).rejects.toThrow("nonce")
  })

  test("audience が一致しなければ拒否する", async () => {
    await expect(
      verifyIdToken(
        {
          issuer: ISSUER,
          audience: "oaiapp_example",
          nonce: "expected-nonce",
          keyResolver,
        },
        await signIdToken({ audience: "another-client" }),
      ),
    ).rejects.toThrow()
  })

  test("issuer が一致しなければ拒否する", async () => {
    await expect(
      verifyIdToken(
        {
          issuer: ISSUER,
          audience: "oaiapp_example",
          nonce: "expected-nonce",
          keyResolver,
        },
        await signIdToken({ issuer: "https://example.invalid" }),
      ),
    ).rejects.toThrow()
  })

  test("有効期限が切れていれば拒否する", async () => {
    await expect(
      verifyIdToken(
        {
          issuer: ISSUER,
          audience: "oaiapp_example",
          nonce: "expected-nonce",
          keyResolver,
        },
        await signIdToken({ expiresInSeconds: -3600 }),
      ),
    ).rejects.toThrow()
  })
})
