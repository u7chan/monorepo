import { describe, expect, test } from "bun:test"

import {
  createCodeChallenge,
  createHostId,
  createPkce,
  createRandomValue,
} from "../src/siwc/pkce"

describe("PKCE", () => {
  test("S256 challenge が RFC 7636 Appendix B のテストベクタと一致する", () => {
    expect(
      createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  test("verifier は 43 文字以上で、呼ぶたびに変わる", () => {
    const first = createPkce()
    const second = createPkce()
    expect(first.verifier.length).toBeGreaterThanOrEqual(43)
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.method).toBe("S256")
    expect(first.challenge).toBe(createCodeChallenge(first.verifier))
  })

  test("state / nonce に使う値は base64url の文字だけを含む", () => {
    expect(createRandomValue(24)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("host ID は urn:uuid 形式", () => {
    expect(createHostId()).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
  })
})
