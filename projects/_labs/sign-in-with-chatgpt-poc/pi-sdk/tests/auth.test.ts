import { describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forceExpireStoredToken } from "../src/auth.js"
import type { Config } from "../src/config.js"

function withTempConfig<T>(auth: unknown, fn: (config: Config) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "siwc-pi-auth-"))
  const authPath = join(dir, "auth.json")
  if (auth !== undefined) {
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
  }
  const config = {
    storageDir: dir,
    authPath,
    deviceIdPath: join(dir, "device-id"),
  } as Config
  try {
    return fn(config)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("forceExpireStoredToken", () => {
  test("OAuth 資格情報の expires だけを過去にし、権限を保つ", () => {
    withTempConfig(
      {
        openai: {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: Date.now() + 3_600_000,
        },
      },
      (config) => {
        expect(forceExpireStoredToken(config, 1_000_000)).toBe(true)
        const stored = JSON.parse(readFileSync(config.authPath, "utf-8")) as {
          openai: {
            type: string
            access: string
            refresh: string
            expires: number
          }
        }
        expect(stored.openai.expires).toBe(999_000)
        expect(stored.openai.access).toBe("a")
        expect(stored.openai.refresh).toBe("r")
        expect(statSync(config.authPath).mode & 0o777).toBe(0o600)
      },
    )
  })

  test("api_key しかない場合は何もしない", () => {
    withTempConfig(
      { openai: { type: "api_key", key: "sk-test" } },
      (config) => {
        expect(forceExpireStoredToken(config)).toBe(false)
      },
    )
  })

  test("ファイルが無い・壊れている場合は false", () => {
    withTempConfig(undefined, (config) => {
      expect(forceExpireStoredToken(config)).toBe(false)
    })
    const dir = mkdtempSync(join(tmpdir(), "siwc-pi-auth-broken-"))
    try {
      const authPath = join(dir, "auth.json")
      writeFileSync(authPath, "{ not json")
      expect(forceExpireStoredToken({ authPath } as Config)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
