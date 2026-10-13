import { describe, expect, test } from "bun:test"
import {
  summarizeRequestPayload,
  summarizeResponseHeaders,
} from "../src/recorder.js"

describe("summarizeRequestPayload", () => {
  test("Responses API の主要フィールドだけを取り出す", () => {
    const summary = summarizeRequestPayload({
      model: "gpt-6-luna",
      store: false,
      stream: true,
      instructions: "You are a helpful assistant.",
      input: [{ type: "message" }, { type: "message" }],
      tools: [
        { type: "function", name: "bash" },
        { type: "function", name: "read" },
      ],
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-1",
      max_output_tokens: 2048,
      temperature: 0,
    })

    expect(summary.model).toBe("gpt-6-luna")
    expect(summary.store).toBe(false)
    expect(summary.stream).toBe(true)
    expect(summary.inputItems).toBe(2)
    expect(summary.toolNames).toEqual(["bash", "read"])
    expect(summary.reasoningEffort).toBe("medium")
    expect(summary.include).toEqual(["reasoning.encrypted_content"])
    expect(summary.hasPromptCacheKey).toBe(true)
    expect(summary.hasInstructions).toBe(true)
    expect(summary.maxOutputTokens).toBe(2048)
  })

  test("input の role を順に記録する", () => {
    const summary = summarizeRequestPayload({
      model: "gpt-6-luna",
      input: [
        { role: "developer", content: "system" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    })
    expect(summary.inputRoles).toEqual(["developer", "user"])
  })

  test("undefined のフィールドは wire に出ないものとして扱う", () => {
    const summary = summarizeRequestPayload({
      model: "gpt-6-luna",
      stream: true,
      store: false,
      prompt_cache_key: "session-1",
      prompt_cache_retention: undefined,
      prompt_cache_options: undefined,
      max_output_tokens: undefined,
    })
    expect(summary.topLevelKeys).toEqual([
      "model",
      "prompt_cache_key",
      "store",
      "stream",
    ])
    expect(summary.promptCacheRetention).toBeUndefined()
    expect(summary.maxOutputTokens).toBeUndefined()
  })

  test("オブジェクトでない payload でも落ちない", () => {
    const summary = summarizeRequestPayload(undefined)
    expect(summary.topLevelKeys).toEqual([])
    expect(summary.inputItems).toBe(0)
    expect(summary.toolNames).toEqual([])
    expect(summary.store).toBeUndefined()
  })

  test("payload 内の認可ヘッダー相当の値は summary へ含めない", () => {
    const summary = summarizeRequestPayload({
      model: "gpt-6-luna",
      authorization: "Bearer secret-token",
      headers: { authorization: "Bearer secret-token" },
    })
    expect(JSON.stringify(summary)).not.toContain("secret-token")
    expect(summary.topLevelKeys).toEqual(["authorization", "headers", "model"])
  })
})

describe("summarizeResponseHeaders", () => {
  test("allowlist のヘッダーだけを残す", () => {
    const summary = summarizeResponseHeaders(200, {
      "content-type": "text/event-stream",
      "x-request-id": "req_123",
      "openai-version": "2020-10-01",
      "set-cookie": "session=secret",
      authorization: "Bearer secret",
    })
    expect(summary.status).toBe(200)
    expect(summary.contentType).toBe("text/event-stream")
    expect(summary.requestId).toBe("req_123")
    expect(summary.openaiVersion).toBe("2020-10-01")
    expect(JSON.stringify(summary)).not.toContain("secret")
  })
})
