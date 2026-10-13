import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelRuntime, describeAuth } from "../src/auth.js"
import type { Config } from "../src/config.js"

async function withTempConfig<T>(
  auth: unknown,
  fn: (config: Config) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "siwc-pi-report-"))
  const authPath = join(dir, "auth.json")
  if (auth !== undefined) {
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
  }
  const config = {
    storageDir: dir,
    authPath,
    deviceIdPath: join(dir, "device-id"),
    modelId: "gpt-6-luna",
  } as Config
  try {
    return await fn(config)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("describeAuth", () => {
  test("資格情報が無ければ openai / openai-codex とも未設定として報告する", async () => {
    const previous = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      await withTempConfig(undefined, async (config) => {
        const runtime = await createModelRuntime(config)
        const report = await describeAuth(runtime, config)
        expect(report.provider).toBe("openai")
        expect(report.configured).toBe(false)
        expect(report.credentialType).toBeUndefined()
        expect(report.usingOAuth).toBe(false)
        expect(report.codex.configured).toBe(false)
      })
    } finally {
      if (previous !== undefined) {
        process.env.OPENAI_API_KEY = previous
      }
    }
  })

  test("SIWC の OAuth 資格情報を openai 経路として報告する", async () => {
    const scopes = [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ]
    await withTempConfig(
      {
        openai: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3_600_000,
          clientId: "oaiapp_example",
          scopes,
        },
      },
      async (config) => {
        const runtime = await createModelRuntime(config)
        const report = await describeAuth(runtime, config)
        expect(report.configured).toBe(true)
        expect(report.credentialType).toBe("oauth")
        expect(report.usingOAuth).toBe(true)
        expect(report.usingSubscription).toBe(true)
        expect(report.hasRefreshToken).toBe(true)
        expect(report.clientId).toBe("oaiapp_example")
        expect(report.scopes).toEqual(scopes)
        expect(report.expiresInSeconds).toBeGreaterThan(0)
        expect(report.codex.usingOAuth).toBe(false)
        // アクセストークンそのものは report に含めない
        expect(JSON.stringify(report)).not.toContain("access-token")
      },
    )
  })
})
