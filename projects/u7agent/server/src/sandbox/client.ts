/**
 * BFF からサンドボックス ツール実行 API を呼ぶクライアント。NDJSON を execute() の契約
 * (onUpdate / result / abort) に写し替え、abort は cancel エンドポイントと接続切断の両方で伝播させる。
 */
import {
  decodeSandboxEvent,
  type SandboxCreateDirResult,
  type SandboxEvent,
  type SandboxFileListing,
  type SandboxFilePreview,
  type SandboxFileUpload,
  type SandboxSkillsResponse,
} from "./protocol";

export interface SandboxToolClientOptions {
  baseUrl: string;
  token: string;
  /** テストで差し替える fetch 実装 */
  fetchImpl?: typeof fetch;
}

export interface SandboxExecuteInput {
  toolCallId?: string;
  params: unknown;
  cwd?: string;
  signal?: AbortSignal | undefined;
  onUpdate?: ((partial: { content: unknown; details?: unknown }) => void) | undefined;
}

export interface SandboxExecuteResult {
  content: unknown;
  details?: unknown;
}

/** raw 配信の応答。BFF はヘッダを付け直してストリームをそのまま流す。 */
export interface SandboxRawFile {
  contentType: string;
  contentLength?: number;
  body: ReadableStream<Uint8Array> | null;
}

export interface SandboxUploadInput {
  /** root 相対の保存先ディレクトリ (アップロードの場合は `uploads` など) */
  dir: string;
  /** 保存名 (basename)。同名があればサンドボックスが連番を振る */
  name: string;
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal | undefined;
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
    listSkills: (dir) => listSkills(dir, baseUrl, token, fetchImpl),
    previewFile: async (path) => {
      const response = await fetchJson(
        fetchImpl,
        `${baseUrl}/v1/files/preview?path=${encodeURIComponent(path)}`,
        { headers: jsonHeaders(token) },
        baseUrl,
      );
      if (!response.ok) throw await jsonError(response, "プレビューを取得できませんでした");
      return (await response.json()) as SandboxFilePreview;
    },
    createDir: (path) => createDir(path, baseUrl, token, fetchImpl),
    deleteFile: (path) => deleteFile(path, baseUrl, token, fetchImpl),
    deleteDirectory: (path) => deleteDirectory(path, baseUrl, token, fetchImpl),
    uploadFile: (input) => uploadFile(input, baseUrl, token, fetchImpl),
    rawFile: (path) => rawFile(path, baseUrl, token, fetchImpl),
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
  previewFile(path: string): Promise<SandboxFilePreview>;
  execute(toolName: string, input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
  listFiles(path: string): Promise<SandboxFileListing>;
  /** `.agents/skills` 配下の発見 (dir は root 相対)。不存在の dir は 404 */
  listSkills(dir: string): Promise<SandboxSkillsResponse>;
  createDir(path: string): Promise<SandboxCreateDirResult>;
  deleteFile(path: string): Promise<void>;
  /** 配下ごとのディレクトリ削除 (recursive はサンドボックスが true 固定で受ける) */
  deleteDirectory(path: string): Promise<void>;
  uploadFile(input: SandboxUploadInput): Promise<SandboxFileUpload>;
  rawFile(path: string): Promise<SandboxRawFile>;
}

/** /api/files とプロジェクト作成・アップロードが使うサンドボックス機能 (テストはこれを stub に差し替える)。 */
export type SandboxWorkspaceClient = Pick<
  SandboxToolClient,
  "listFiles" | "listSkills" | "createDir" | "deleteFile" | "deleteDirectory" | "previewFile" | "uploadFile" | "rawFile"
>;

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

/** NDJSON の execute とは別経路 (JSON 応答)。接続できない場合はサンドボックスの到達性の問題として 502 にする。 */
async function fetchJson(fetchImpl: typeof fetch, url: string, init: RequestInit, baseUrl: string): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new SandboxRequestError(`サンドボックス (${baseUrl}) に接続できません: ${messageFor(error)}`, 502);
  }
}

function jsonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/**
 * JSON 経路の HTTP エラーの写像。サンドボックス由来の 4xx (不正パス・不存在) は文言ごと透過し、
 * 認証失敗とサンドボックス側障害は 502 に寄せる。
 */
async function jsonError(response: Response, label: string): Promise<SandboxRequestError> {
  const detail = errorDetailOf(await response.text().catch(() => ""));
  if (response.status === 401 || response.status === 403) {
    return new SandboxRequestError("サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)", 502);
  }
  if (response.status === 400 || response.status === 404) {
    return new SandboxRequestError(detail || `${label} (HTTP ${response.status})`, response.status);
  }
  return new SandboxRequestError(
    `サンドボックスの${label} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    502,
  );
}

async function listFiles(
  path: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxFileListing> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files?path=${encodeURIComponent(path)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "ファイル一覧を取得できませんでした");
  return (await response.json()) as SandboxFileListing;
}

async function listSkills(
  dir: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxSkillsResponse> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills?dir=${encodeURIComponent(dir)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "スキル一覧を取得できませんでした");
  // 200 でも本文が契約外 (切断・プロキシの HTML など) ならサンドボックス側の問題として 502 に寄せる。
  // ここで投げる SyntaxError は呼び出し側の「内部エラー = 500」と区別が付かない
  try {
    return (await response.json()) as SandboxSkillsResponse;
  } catch (error) {
    throw new SandboxRequestError(`スキル一覧の応答が不正です: ${messageFor(error)}`, 502);
  }
}

async function createDir(
  path: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxCreateDirResult> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/dirs`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "ディレクトリを作成できませんでした");
  return (await response.json()) as SandboxCreateDirResult;
}

/**
 * raw ストリームでファイルを送る。サンドボックス側が上限と保存名を決めるため、BFF は検証済みの
 * dir / name を渡すだけでよい。
 */
async function uploadFile(
  input: SandboxUploadInput,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxFileUpload> {
  const url = `${baseUrl}/v1/files/upload?dir=${encodeURIComponent(input.dir)}&name=${encodeURIComponent(input.name)}`;
  const response = await fetchJson(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/octet-stream" },
      body: input.body,
      // Node の fetch はストリーム body に duplex: "half" を要求する
      duplex: "half",
      signal: input.signal,
    } as RequestInit,
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "アップロードに失敗しました");
  return (await response.json()) as SandboxFileUpload;
}

/** 通常ファイルの削除。成功は 204 で本文が無いため、応答の JSON は読まない。 */
async function deleteFile(path: string, baseUrl: string, token: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE", headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "ファイルを削除できませんでした");
}

/**
 * 配下ごとのディレクトリ削除。`recursive=true` を明示し、サンドボックス側が空ディレクトリ専用の経路と分岐する。
 * 成功は 204 で本文が無いため、応答の JSON は読まない。
 */
async function deleteDirectory(path: string, baseUrl: string, token: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/dirs?path=${encodeURIComponent(path)}&recursive=true`,
    { method: "DELETE", headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "ディレクトリを削除できませんでした");
}

/** 画像の生配信。4xx (不正パス・不存在・上限超過) は文言ごと透過する。 */
async function rawFile(path: string, baseUrl: string, token: string, fetchImpl: typeof fetch): Promise<SandboxRawFile> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/raw?path=${encodeURIComponent(path)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "ファイルを配信できませんでした");
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  return {
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    body: response.body,
  };
}

/**
 * raw 経路のエラー写像。413 (上限超過) は raw 固有なので、JSON 経路 (jsonError) とは分けて透過する。
 */
async function rawError(response: Response, label: string): Promise<SandboxRequestError> {
  const detail = errorDetailOf(await response.text().catch(() => ""));
  if (response.status === 401 || response.status === 403) {
    return new SandboxRequestError("サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)", 502);
  }
  if (response.status === 400 || response.status === 404 || response.status === 413) {
    return new SandboxRequestError(detail || `${label} (HTTP ${response.status})`, response.status);
  }
  return new SandboxRequestError(
    `サンドボックスの${label} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    502,
  );
}

/** サンドボックスの本文は { error } を返す契約。読めなければ生テキストをそのまま使う。 */
function errorDetailOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // 生テキストを使う
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
        body: JSON.stringify({ toolCallId: input.toolCallId, params: input.params, cwd: input.cwd }),
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
