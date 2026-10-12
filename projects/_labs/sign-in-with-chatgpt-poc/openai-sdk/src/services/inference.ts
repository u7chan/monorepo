import { type DisplayError, hintFor, SicwRequestError } from "../siwc/errors"
import { readObjectProperty, readStringProperty } from "../siwc/fetch"

export type ChatMessage = {
  role: "user" | "assistant"
  content: string
}

export type ChatRequest = {
  model: string
  instructions: string
  input: ChatMessage[]
  /** SIWC 経由では未対応。未対応フィールドのエラー挙動を確認するときだけ送る。 */
  temperature?: number
}

export type ChatEvent =
  | { type: "response"; responseId: string | null }
  | { type: "delta"; text: string }
  | { type: "completed"; responseId: string | null; usage: unknown }
  | { type: "incomplete"; reason: string | null }
  | { type: "failed"; error: DisplayError }

export type ResponseStreamEventLike = { type: string }

export type CreateResponseStream = (
  request: ChatRequest,
  options: { signal: AbortSignal },
) => Promise<AsyncIterable<ResponseStreamEventLike>>

/**
 * Responses API のストリームを、SSE で送るイベントに変換する。
 * `response.completed` を受け取るまでは成功として扱わない。
 */
export async function* streamChatResponse(
  createStream: CreateResponseStream,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const stream = await createStream(request, { signal })
  let completed = false

  for await (const event of stream) {
    switch (event.type) {
      case "response.created": {
        yield {
          type: "response",
          responseId: readStringProperty(
            readObjectProperty(event, "response"),
            "id",
          ),
        }
        break
      }
      case "response.output_text.delta": {
        const delta = readStringProperty(event, "delta")
        if (delta !== null && delta.length > 0) {
          yield { type: "delta", text: delta }
        }
        break
      }
      case "response.completed": {
        completed = true
        const response = readObjectProperty(event, "response")
        yield {
          type: "completed",
          responseId: readStringProperty(response, "id"),
          usage: readObjectProperty(response, "usage") ?? null,
        }
        break
      }
      case "response.incomplete": {
        const details = readObjectProperty(
          readObjectProperty(event, "response"),
          "incomplete_details",
        )
        yield {
          type: "incomplete",
          reason: readStringProperty(details, "reason"),
        }
        return
      }
      case "response.failed": {
        const error = readObjectProperty(
          readObjectProperty(event, "response"),
          "error",
        )
        yield {
          type: "failed",
          error: streamError(error, "response.failed を受け取りました。"),
        }
        return
      }
      case "error": {
        yield {
          type: "failed",
          error: streamError(
            event,
            "ストリームでエラーイベントを受け取りました。",
          ),
        }
        return
      }
      default:
        break
    }
  }

  if (completed || signal.aborted) {
    return
  }
  throw new SicwRequestError({
    message: "response.completed を受け取らないままストリームが終了しました。",
    code: "stream_without_completion",
  })
}

function streamError(payload: unknown, fallbackMessage: string): DisplayError {
  const code = readStringProperty(payload, "code")
  return {
    status: null,
    code,
    param: readStringProperty(payload, "param"),
    message: readStringProperty(payload, "message") ?? fallbackMessage,
    requestId: null,
    hint: hintFor(code),
  }
}
