/**
 * BFF からサンドボックス ツール実行API を呼ぶクライアント。
 *
 * NDJSON ストリームを解釈し、SDK ツール定義の execute() 契約
 * (onUpdate での途中出力、最終結果、abort) に写し替える。
 * abort はできるだけ早くサンドボックスへ伝播させる: cancel エンドポイント
 * (実行IDが分かっている場合) と接続切断 (start 前や fallback) を併用する。
 */
import { decodeSandboxEvent, type SandboxEvent } from "./protocol";

export interface SandboxToolClientOptions {
  /** 例: http://pi-agent-gui-sandbox:8080 (末尾スラッシュは正規化する)。 */
  baseUrl: string;
  /** Bearer トークン (PI_SANDBOX_TOKEN)。 */
  token: string;
  /** テストで差し替える場合の fetch 実装。 */
  fetchImpl?: typeof fetch;
}

export interface SandboxExecuteInput {
  toolCallId?: string;
  params: unknown;
  signal?: AbortSignal | undefined;
  onUpdate?: ((partial: { content: unknown; details?: unknown }) => void) | undefined;
}

export interface SandboxExecuteResult {
  content: unknown;
  details?: unknown;
}

export function createSandboxToolClient(options: SandboxToolClientOptions): SandboxToolClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const token = options.token.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!baseUrl || !token) {
    throw new Error("Sandbox tool client requires baseUrl and token");
  }
  return { execute: (toolName, input) => execute(toolName, input, baseUrl, token, fetchImpl) };
}

/** 環境変数からクライアントを生成する。未設定時は undefined (起動はできるがセッション作成は不可)。 */
export function createSandboxToolClientFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): ReturnType<typeof createSandboxToolClient> | undefined {
  const baseUrl = env.PI_SANDBOX_URL?.trim();
  const token = env.PI_SANDBOX_TOKEN?.trim();
  if (!baseUrl || !token) return undefined;
  return createSandboxToolClient({ baseUrl, token, fetchImpl });
}

export interface SandboxToolClient {
  /**
   * サンドボックスでツールを実行する。完了 (result) まで解決し、エラー
   * イベント・HTTP エラー・中断は reject する。
   */
  execute(toolName: string, input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
}

async function execute(
  toolName: string,
  input: SandboxExecuteInput,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxExecuteResult> {
  if (input.signal?.aborted) {
    throw new Error("Operation aborted");
  }
  // サンドボックス側の abort はこの controller と input.signal の両方から掛かる。
  const controller = new AbortController();
  let executionId: string | undefined;
  const onOuterAbort = () => {
    // cancel エンドポイントが知らないうち (start 前) は接続切断に任せる。
    if (executionId) {
      void fetchImpl(`${baseUrl}/v1/executions/${encodeURIComponent(executionId)}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }).catch(() => {});
    }
    controller.abort();
  };
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/tools/${encodeURIComponent(toolName)}/execute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({ toolCallId: input.toolCallId, params: input.params }),
        signal: controller.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw new Error("Operation aborted");
      throw new Error(`サンドボックス (${baseUrl}) に接続できません: ${messageFor(error)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new Error("サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)");
      }
      if (response.status === 404) {
        throw new Error(`サンドボックスにツールがありません: ${toolName}`);
      }
      throw new Error(
        `サンドボックスのツール実行が失敗しました (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!response.body) {
      throw new Error("サンドボックスがストリームを返しませんでした");
    }

    return await consumeStream(response.body, input, {
      setExecutionId: (id) => {
        executionId = id;
      },
      isOuterAborted: () => Boolean(input.signal?.aborted),
    });
  } finally {
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  input: SandboxExecuteInput,
  hooks: {
    setExecutionId: (id: string) => void;
    isOuterAborted: () => boolean;
  },
): Promise<SandboxExecuteResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawResult: SandboxExecuteResult | undefined;

  const handle = (event: SandboxEvent): void => {
    switch (event.type) {
      case "start":
        hooks.setExecutionId(event.executionId);
        break;
      case "update":
        input.onUpdate?.({ content: event.payload?.content, details: event.payload?.details });
        break;
      case "result":
        sawResult = { content: event.payload?.content ?? [], details: event.payload?.details };
        break;
      case "error":
        throw new Error(event.message);
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handle(decodeSandboxEvent(line));
        if (sawResult) return sawResult;
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail && !sawResult) handle(decodeSandboxEvent(tail));
  } catch (error) {
    if (hooks.isOuterAborted()) throw new Error("Operation aborted");
    if (error instanceof Error && /aborted/i.test(error.message)) {
      throw input.signal?.aborted ? new Error("Operation aborted") : error;
    }
    throw error;
  } finally {
    reader.cancel().catch(() => {});
  }

  if (hooks.isOuterAborted()) throw new Error("Operation aborted");
  if (sawResult) return sawResult;
  throw new Error("サンドボックスが結果を返さずに切断しました");
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
