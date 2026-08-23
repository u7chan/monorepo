import { beforeEach, describe, expect, it, mock } from "bun:test"

// ---------------------------------------------------------------------------
// Fake Pi SDK
//
// テストは実モデル・ネットワーク・API キーに依存しない。
// ハーネスが Pi SDK にどう接続するか(オプション・イベント購読・破棄)を
// フェイクで記録して検証する。
// ---------------------------------------------------------------------------

type EventListener = (event: unknown) => void

interface FakeSession {
  subscribe: (listener: EventListener) => () => void
  prompt: (text: string) => Promise<void>
  dispose: () => void
}

interface FakeOptions {
  modelRuntime?: unknown
  sessionManager?: unknown
  noTools?: unknown
  model?: unknown
  thinkingLevel?: unknown
}

let capturedOptions: FakeOptions | undefined
let lastPrompt = ""
let disposeCalls = 0
let listeners: EventListener[] = []

function emitTextDeltas(deltas: string[]) {
  for (const delta of deltas) {
    for (const listener of listeners) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      })
    }
  }
}

function createFakeSession(): FakeSession {
  return {
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        listeners = listeners.filter((l) => l !== listener)
      }
    },
    async prompt(text) {
      lastPrompt = text
      emitTextDeltas(["Hello", " ", "world"])
    },
    dispose() {
      disposeCalls += 1
    },
  }
}

mock.module("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: async () => ({ kind: "fake-model-runtime" }),
  },
  SessionManager: {
    inMemory: () => "in-memory",
  },
  resolveCliModel: ({ cliModel }: { cliModel?: string }) => {
    // 実在のプロバイダー・モデルに依存させず、架空のマスタで検証する
    if (cliModel === "fake-provider/fake-model") {
      return {
        model: { kind: "fake-model" },
        thinkingLevel: undefined,
        warning: undefined,
        error: undefined,
      }
    }
    if (cliModel === "fake-provider/fake-model:low") {
      return {
        model: { kind: "fake-model" },
        thinkingLevel: "low",
        warning: undefined,
        error: undefined,
      }
    }
    return {
      model: undefined,
      thinkingLevel: undefined,
      warning: undefined,
      error: `unknown model: "${cliModel}"`,
    }
  },
  createAgentSession: async (options: FakeOptions) => {
    capturedOptions = options
    return { session: createFakeSession() }
  },
}))

const { createHarness } = await import("../src/harness")

// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedOptions = undefined
  lastPrompt = ""
  disposeCalls = 0
  listeners = []
})

describe("createHarness()", () => {
  it("builds an in-memory, tool-free Pi session", async () => {
    await createHarness()

    expect(capturedOptions).toEqual({
      modelRuntime: { kind: "fake-model-runtime" },
      sessionManager: "in-memory",
      noTools: "all",
    })
  })

  it("resolves the given model spec and passes it to the session", async () => {
    await createHarness({ model: "fake-provider/fake-model" })

    expect(capturedOptions?.model).toEqual({ kind: "fake-model" })
    expect(capturedOptions?.thinkingLevel).toBeUndefined()
  })

  it("applies the thinking level from the model spec", async () => {
    await createHarness({ model: "fake-provider/fake-model:low" })

    expect(capturedOptions?.model).toEqual({ kind: "fake-model" })
    expect(capturedOptions?.thinkingLevel).toBe("low")
  })

  it("rejects an unknown model spec at creation time", async () => {
    await expect(createHarness({ model: "bad/spec" })).rejects.toThrow(
      'unknown model: "bad/spec"',
    )
  })

  it("returns the assistant's reply text from prompt()", async () => {
    const harness = await createHarness()

    const result = await harness.prompt("hello")

    expect(lastPrompt).toBe("hello")
    expect(result).toBe("Hello world")
  })

  it("replaces the previous reply when prompt() is called again", async () => {
    const harness = await createHarness()

    await harness.prompt("first")
    const second = await harness.prompt("second")

    expect(second).toBe("Hello world")
  })

  it("dispose() unsubscribes from events and releases the Pi session", async () => {
    const harness = await createHarness()

    harness.dispose()

    expect(disposeCalls).toBe(1)
    expect(listeners).toHaveLength(0)
  })
})
