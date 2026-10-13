import { createHash } from "node:crypto"

/**
 * ローカルの Responses API スタブ。認証やネットワークなしで Pi のエージェントループ
 * （ツール呼び出し → 実行 → 続きの推論）を通すためだけに使う。
 * 実推論の互換性確認には使わない。
 */
export interface StubResponsesServer {
  /** models.json に書く baseUrl（例: http://127.0.0.1:12345/v1） */
  baseUrl: string
  /** 受信したリクエストボディ（トークンは含まれない） */
  requests: Array<Record<string, unknown>>
  /** 2 回目のリクエストから取り出した tool 出力 */
  toolOutputs: string[]
  /**
   * 各リクエストの `Authorization` ヘッダーの指紋（sha256 の hex）。
   * 値そのものは保持しないが、渡した資格情報が実際に使われたかは照合できる。
   */
  authHeaderDigests: string[]
  stop(): void
}

/** スタブが記録する `Authorization` ヘッダーの指紋を計算する */
export function authorizationDigest(token: string): string {
  return createHash("sha256").update(`Bearer ${token}`).digest("hex")
}

export interface StubResponsesOptions {
  /** 1 回目のリクエストでモデルに呼ばせる bash コマンド */
  toolCommand?: string
  /** 2 回目のリクエストで返す本文 */
  finalText?: string
}

function sse(events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
}

function functionCallEvents(
  name: string,
  args: Record<string, unknown>,
  responseId: string,
): string {
  const itemId = "fc_stub_1"
  const callId = "call_stub_1"
  const argumentsJson = JSON.stringify(args)
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsJson,
  }
  return sse([
    {
      type: "response.created",
      response: { id: responseId, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: itemId,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: itemId,
      arguments: argumentsJson,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ])
}

function messageEvents(text: string, responseId: string): string {
  const itemId = "msg_stub_1"
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  }
  return sse([
    {
      type: "response.created",
      response: { id: responseId, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: itemId, role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: itemId,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
      },
    },
  ])
}

function collectToolOutputs(body: Record<string, unknown>): string[] {
  const input = Array.isArray(body.input) ? body.input : []
  return input.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return []
    }
    const item = entry as Record<string, unknown>
    return item.type === "function_call_output" &&
      typeof item.output === "string"
      ? [item.output]
      : []
  })
}

export function startStubResponsesServer(
  options: StubResponsesOptions = {},
): StubResponsesServer {
  const toolCommand = options.toolCommand ?? "env"
  const finalText = options.finalText ?? "stub ok"
  const requests: Array<Record<string, unknown>> = []
  const toolOutputs: string[] = []
  const authHeaderDigests: string[] = []
  let responseCount = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) {
        return new Response("not found", { status: 404 })
      }

      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      const authorization = request.headers.get("authorization")
      authHeaderDigests.push(
        authorization === null
          ? ""
          : createHash("sha256").update(authorization).digest("hex"),
      )
      toolOutputs.push(...collectToolOutputs(body))
      responseCount += 1

      const hasToolResult = collectToolOutputs(body).length > 0
      // 1 回目だけツールを呼ばせ、それ以降は本文を返してループを止める
      const wantsToolCall = !hasToolResult && responseCount === 1
      const payload = wantsToolCall
        ? functionCallEvents(
            "bash",
            { command: toolCommand },
            `resp_stub_${responseCount}`,
          )
        : messageEvents(finalText, `resp_stub_${responseCount}`)

      return new Response(payload, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      })
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    toolOutputs,
    authHeaderDigests,
    stop() {
      server.stop(true)
    },
  }
}
