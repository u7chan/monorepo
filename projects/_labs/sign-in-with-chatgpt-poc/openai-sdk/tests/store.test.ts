import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SessionStore, type StoredSession } from "../src/siwc/store"

const SESSION: StoredSession = {
  registration: {
    clientId: "oaiapp_example",
    email: "user@example.com",
    subject: "subject-1",
    issuer: "https://auth.openai.com",
    extAgentHostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
    registeredAt: "2026-01-01T00:00:00.000Z",
  },
  tokens: {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    expiresAt: "2026-01-01T01:00:00.000Z",
    savedAt: "2026-01-01T00:00:00.000Z",
  },
}

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function createStore(): Promise<SessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "siwc-store-"))
  temporaryDirectories.push(directory)
  return new SessionStore(directory)
}

describe("SessionStore", () => {
  test("0600 で保存し、そのまま読み戻せる", async () => {
    const store = await createStore()
    await store.save(SESSION)

    expect(await store.read()).toEqual(SESSION)
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600)
  })

  test("ファイルがなければ null を返す", async () => {
    expect(await (await createStore()).read()).toBeNull()
  })

  test("clearTokens は registration を残してトークンだけ消す", async () => {
    const store = await createStore()
    await store.save(SESSION)

    await store.clearTokens()

    const stored = await store.read()
    expect(stored?.registration).toEqual(SESSION.registration)
    expect(stored?.tokens).toBeNull()
  })

  test("形式が違う JSON は黙って捨てずにエラーにする", async () => {
    const store = await createStore()
    await store.save(SESSION)
    await writeFile(store.filePath, JSON.stringify({ tokens: null }))

    await expect(store.read()).rejects.toThrow("想定した形式ではありません")
  })
})
