import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app"

describe("GET /", () => {
  it("returns greeting text", async () => {
    const app = createApp()
    const res = await app.request("/")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("Hello Hono!")
  })
})

describe("GET /healthz", () => {
  it("returns ok status", async () => {
    const app = createApp()
    const res = await app.request("/healthz")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})
