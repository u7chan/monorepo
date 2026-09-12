/**
 * BFF からサンドボックス ツール実行 API を呼ぶクライアント。NDJSON を execute() の契約
 * (onUpdate / result / abort) に写し替え、abort は cancel エンドポイントと接続切断の両方で伝播させる。
 */
import { decodeSandboxEvent, type SandboxEvent, type SandboxFileListing } from "./protocol";

export interface SandboxToolClientOptions {
  /** 例: http://pi-agent-gui-sandbox:8080 (末尾スラッシュは正規化する) */
  baseUrl: string;
  /** Bearer トークン (PI_SANDBOX_TOKEN) */
  token: string;
  /** テストで差し替える fetch 実装 */
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
  return {
    execute: (toolName, input) => execute(toolName, input, baseUrl, token, fetchImpl),
    listFiles: (path) => listFiles(path, baseUrl, token, fetchImpl),
  };
}

/** 未設定時は undefined を返し、起動はできるがセッション作成は 503 になる。 */
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
  /** 完了 (result) まで解決し、エラーイベント・HTTP エラー・中断は reject する。 */
  execute(toolName: string, input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
  /** root 相対パスの一覧 (JSON)。root 外・不存在などは SandboxRequestError で reject する。 */
  listFiles(path: string): Promise<SandboxFileListing>;
}

/** /api/files が使うサンドボックス機能 (テストはこれを stub に差し替える)。 */
export type SandboxFilesClient = Pick<SandboxToolClient, "listFiles">;

/**
 * status は BFF がそのまま応答に使うステータス。サンドボックス由来の 4xx (不正パス・不存在) は透過し、
 * 接続失敗・認証失敗・サンドボックス側障害は 502 に寄せる。
 */
export class SandboxRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SandboxRequestError";
  }
}

/** NDJSON の execute とは別経路 (JSON 応答)。 */
async function listFiles(
  path: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxFileListing> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/files?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (error) {
    throw new SandboxRequestError(`サンドボックス (${baseUrl}) に接続できません: ${messageFor(error)}`, 502);
  }

  if (!response.ok) {
    const detail = errorDetailOf(await response.text().catch(() => ""));
    if (response.status === 401 || response.status === 403) {
      throw new SandboxRequestError(
        "サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)",
        502,
      );
    }
    if (response.status === 400 || response.status === 404) {
      // 不正パス・不存在は要求側の問題なので、サンドボックスの文言 (ls ツールに寄せた英語) をそのまま返す
      throw new SandboxRequestError(
        detail || `ファイル一覧を取得できませんでした (HTTP ${response.status})`,
        response.status,
      );
    }
    throw new SandboxRequestError(
      `サンドボックスのファイル一覧を取得できませんでした (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      502,
    );
  }

  return (await response.json()) as SandboxFileListing;
}

/** サンドボックスの本文は { error } を返す契約。読めなければ生テキストをそのまま使う。 */
function errorDetailOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // JSON でない本文はそのまま使う
  }
  return trimmed;
}

/** cancel 要求自身が伝搬経路を塞がないよう、独立した短いタイムアウトで送る。 */
const SANDBOX_CANCEL_TIMEOUT_MS = 5000;

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
    // start 前は実行 ID が無く cancel を送れないため、接続切断に任せる。
    // controller.signal はこの直後に abort されるので、cancel は専用のタイムアウトで送る。
    if (executionId) {
      void fetchImpl(`${baseUrl}/v1/executions/${encodeURIComponent(executionId)}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SANDBOX_CANCEL_TIMEOUT_MS),
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
