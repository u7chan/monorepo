import { createHash, randomBytes, randomUUID } from "node:crypto"

export type Pkce = {
  verifier: string
  challenge: string
  method: "S256"
}

export function createPkce(): Pkce {
  const verifier = createRandomValue(32)
  return { verifier, challenge: createCodeChallenge(verifier), method: "S256" }
}

export function createCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export function createRandomValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function createHostId(): string {
  return `urn:uuid:${randomUUID()}`
}
