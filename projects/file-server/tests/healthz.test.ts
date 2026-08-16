import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-healthz"
const AUTH_DIR = path.join(UPLOAD_DIR, ".auth")
let app: Awaited<ReturnType<typeof createTestApp>>

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
})

describe("GET /healthz", () => {
  it("returns 200 when both storage directories are accessible", async () => {
    const res = await app.request(new Request("http://localhost/healthz"))

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("is accessible without a session cookie when auth is enabled", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: "0123456789abcdef0123456789abcdef",
      initialAdminPassword: "test-admin-pass",
    })

    const res = await app.request(new Request("http://localhost/healthz"))

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("returns 503 when a storage directory is unavailable", async () => {
    await rm(path.join(UPLOAD_DIR, "private"), {
      recursive: true,
      force: true,
    })

    const res = await app.request(new Request("http://localhost/healthz"))

    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "unavailable" })
  })
})
