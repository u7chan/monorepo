import { describe, expect, test } from "bun:test"

import {
  type ChatEvent,
  type ChatRequest,
  type CreateResponseStream,
  type ResponseStreamEventLike,
  streamChatResponse,
} from "../src/services/inference"

const request: ChatRequest = {
  model: "model-a",
  instructions: "test instructions",
  input: [{ role: "user", content: "hello" }],
}

function createStreamOf(
  events: object[],
  onCall?: (request: ChatRequest) => void,
): CreateResponseStream {
  return async (chatRequest) => {
    onCall?.(chatRequest)
    return (async function* () {
      for (const event of events) {
        yield event as ResponseStreamEventLike
      }
    })()
  }
}

async function collect(
  createStream: CreateResponseStream,
  signal = new AbortController().signal,
): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = []
  for await (const event of streamChatResponse(createStream, request, signal)) {
    collected.push(event)
  }
  return collected
}

describe("streamChatResponse", () => {
  test("delta を順に流し、completed で usage を返す", async () => {
    const events = await collect(
      createStreamOf([
        { type: "response.created", response: { id: "resp-1" } },
        { type: "response.output_text.delta", delta: "Hello" },
        { type: "response.output_text.delta", delta: ", world" },
        { type: "response.output_text.done", text: "Hello, world" },
        {
          type: "response.completed",
          response: { id: "resp-1", usage: { input_tokens: 3 } },
        },
      ]),
    )

    expect(events).toEqual([
      { type: "response", responseId: "resp-1" },
      { type: "delta", text: "Hello" },
      { type: "delta", text: ", world" },
      { type: "completed", responseId: "resp-1", usage: { input_tokens: 3 } },
    ])
  })

  test("response.failed は code / param / hint を付けて返す", async () => {
    const events = await collect(
      createStreamOf([
        { type: "response.created", response: { id: "resp-2" } },
        {
          type: "response.failed",
          response: {
            id: "resp-2",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "limit",
              param: null,
            },
          },
        },
      ]),
    )

    expect(events).toHaveLength(2)
    const failed = events[1]
    expect(failed?.type).toBe("failed")
    if (failed?.type === "failed") {
      expect(failed.error.code).toBe(
        "subscription_sharing_usage_limit_exceeded",
      )
      expect(failed.error.hint).toContain("利用上限")
    }
  })

  test("error イベントも failed として返す", async () => {
    const events = await collect(
      createStreamOf([
        { type: "error", code: "invalid_request_error", message: "bad input" },
      ]),
    )

    expect(events).toEqual([
      {
        type: "failed",
        error: {
          status: null,
          code: "invalid_request_error",
          param: null,
          message: "bad input",
          requestId: null,
          hint: null,
        },
      },
    ])
  })

  test("response.incomplete は reason を付けて返す", async () => {
    const events = await collect(
      createStreamOf([
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        },
      ]),
    )

    expect(events).toEqual([
      { type: "incomplete", reason: "max_output_tokens" },
    ])
  })

  test("completed を受け取らずに終わったらエラーにする", async () => {
    const promise = collect(
      createStreamOf([
        { type: "response.output_text.delta", delta: "partial" },
      ]),
    )

    await expect(promise).rejects.toThrow("response.completed")
  })

  test("中断されている場合はエラーにしない", async () => {
    const controller = new AbortController()
    controller.abort()

    expect(await collect(createStreamOf([]), controller.signal)).toEqual([])
  })

  test("リクエスト内容をそのままストリーム生成側に渡す", async () => {
    const received: ChatRequest[] = []
    await collect(
      createStreamOf(
        [{ type: "response.completed", response: { id: "resp-3" } }],
        (chatRequest) => {
          received.push(chatRequest)
        },
      ),
    )

    expect(received[0]).toEqual(request)
  })
})
