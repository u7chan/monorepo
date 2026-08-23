import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app"
import type { Harness } from "../src/harness"

const fakeHarness: Harness = {
  prompt: async (text) => `assistant: ${text}`,
  dispose: () => {},
}

function requestPrompt(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("GET /", () => {
  it("returns greeting text", async () => {
    const app = createApp({ harness: fakeHarness })
    const res = await app.request("/")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("Hello Hono!")
  })
})

describe("GET /healthz", () => {
  it("returns ok status", async () => {
    const app = createApp({ harness: fakeHarness })
    const res = await app.request("/healthz")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

describe("POST /prompt", () => {
  it("delegates the prompt to the harness and returns the assistant result", async () => {
    const app = createApp({ harness: fakeHarness })
    const res = await requestPrompt(app, { prompt: "hello" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "assistant: hello" })
  })

  it("returns 400 with an error body when prompt is empty", async () => {
    const app = createApp({ harness: fakeHarness })
    const res = await requestPrompt(app, { prompt: "" })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "prompt must be a non-empty string",
    })
  })

  it("returns 400 with an error body when prompt is missing", async () => {
    const app = createApp({ harness: fakeHarness })
    const res = await requestPrompt(app, {})

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "prompt must be a non-empty string",
    })
  })
})
