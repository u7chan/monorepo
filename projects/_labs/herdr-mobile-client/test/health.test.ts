// Bridge 自身の情報を返す GET /api/health と、ビルド済みクライアントの配信の検証。
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createApp } from "../src/server/app"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
}

test("GET /api/health は ok / version / startedAt だけを返す", async () => {
  const res = await createApp().request("/api/health")

  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /application\/json/)

  const body = (await res.json()) as Record<string, unknown>

  assert.deepEqual(Object.keys(body).sort(), ["ok", "startedAt", "version"])
  assert.equal(body.ok, true)
  assert.equal(body.version, packageJson.version)
  assert.equal(new Date(String(body.startedAt)).toISOString(), body.startedAt)
})

test("clientDir を渡すと index.html を返す", async () => {
  const clientDir = mkdtempSync(join(tmpdir(), "herdr-mobile-client-"))

  try {
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>top</title>")

    const res = await createApp({ clientDir }).request("/")

    assert.equal(res.status, 200)
    assert.equal(await res.text(), "<!doctype html><title>top</title>")
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
  }
})

test("clientDir を渡さない app は静的ファイルを配信しない", async () => {
  const res = await createApp().request("/")

  assert.equal(res.status, 404)
})
