import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readOrCreateDeviceId } from "../src/device-id.js"

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "siwc-pi-device-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("readOrCreateDeviceId", () => {
  test("初回は UUID を 0600 で作成し、2 回目は同じ値を使う", () => {
    withTempDir((dir) => {
      const path = join(dir, "nested", "device-id")
      const first = readOrCreateDeviceId(path)
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700)
      expect(readOrCreateDeviceId(path)).toBe(first)
    })
  })

  test("UUID でない内容は作り直して警告する", () => {
    withTempDir((dir) => {
      const path = join(dir, "device-id")
      writeFileSync(path, "not-a-uuid")
      const warnings: string[] = []
      const value = readOrCreateDeviceId(path, (message) =>
        warnings.push(message),
      )
      expect(value).not.toBe("not-a-uuid")
      expect(warnings).toHaveLength(1)
      expect(readOrCreateDeviceId(path)).toBe(value)
    })
  })
})
