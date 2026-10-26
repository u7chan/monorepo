/**
 * BFF からサンドボックス ツール実行 API を呼ぶクライアント。NDJSON を execute() の契約
 * (onUpdate / result / abort) に写し替え、abort は cancel エンドポイントと接続切断の両方で伝播させる。
 */
import { IMAGE_INPUT_MAX_BYTES } from "../image-format";
import {
  decodeSandboxEvent,
  type SandboxCreateDirResult,
  type SandboxDownloadCheck,
  type SandboxDownloadPlan,
  type SandboxEvent,
  type SandboxFileListing,
  type SandboxFilePreview,
  type SandboxFileStat,
  type SandboxFileUpload,
  type SandboxGitInfo,
  type SandboxHandoffRead,
  type SandboxHandoffRollback,
  type SandboxHandoffWrite,
  type SandboxListenerRangeScan,
  type SandboxListenerScan,
  type SandboxMoveResult,
  type SandboxRenameResult,
  type SandboxRuntimeInfo,
  type SandboxSkillCreateBody,
  type SandboxSkillCreateResult,
  type SandboxSkillDeletePreview,
  type SandboxSkillFileDetail,
  type SandboxSkillSaveBody,
  type SandboxSkillSaveResult,
  type SandboxSkillsImportResult,
  type SandboxSkillsResponse,
  type SandboxWriteScopeEntry,
} from "./protocol";

export interface SandboxToolClientOptions {
  baseUrl: string;
  token: string;
  /** テストで差し替える fetch 実装 */
  fetchImpl?: typeof fetch;
  /** テストで短くできる診断専用の期限 (既定 8s) */
  runtimeInfoTimeoutMs?: number;
  /** テストで短くできる待受観測の期限 (既定 5s) */
  listenerScanTimeoutMs?: number;
}

/**
 * 実行環境の診断専用インターフェース。workspace 操作 (`SandboxWorkspaceClient`) と混ぜずに
 * bootstrap から注入し、既存の workspace テストスタブに診断メソッドを要求しない。
 */
export interface SandboxRuntimeDiagnostics {
  /** 認証付きの実行環境 API。本文の受信完了まで診断専用の期限を適用する */
  getRuntimeInfo(): Promise<SandboxRuntimeInfo>;
}

/** 診断 API の失敗分類。BFF の公開 DTO の state にそのまま写す。 */
export type SandboxRuntimeFailure = "unreachable" | "unauthorized" | "timeout" | "probe_failed";

/** 生のエラー文言はサーバーログにだけ出し、クライアントへは failure の分類だけを返す。 */
export class SandboxRuntimeError extends Error {
  constructor(
    message: string,
    readonly failure: SandboxRuntimeFailure,
  ) {
    super(message);
    this.name = "SandboxRuntimeError";
  }
}

/**
 * BFF → サンドボックスの診断専用 HTTP の期限。既存のファイル操作 / ツール実行のタイムアウト契約は変えず、
 * この経路だけ接続待ちと本文受信の両方に適用する (本文が止まっても UI を待たせない)。
 */
export const SANDBOX_RUNTIME_INFO_TIMEOUT_MS = 8000;

/**
 * 待受観測 (`GET /v1/procs/listeners`) の期限。実測 0.06〜0.08 秒で、停止・起動確認がサンドボックス側の
 * 停止で待ち続けないようにする (serve の操作は直列化されており、待ちは後続の操作を詰まらせる)。
 */
export const SANDBOX_LISTENER_SCAN_TIMEOUT_MS = 5000;

/**
 * 参照画像を 1 枚読み切るまでの期限。作業領域内の読み取りなので短く、超えたら接続を捨てる
 * （ユーザー中断は別に signal で伝播する）。
 */
export const SANDBOX_IMAGE_INPUT_TIMEOUT_MS = 30_000;

export interface SandboxExecuteInput {
  toolCallId?: string;
  params: unknown;
  cwd?: string;
  /**
   * この実行だけの書き込み許可 root (root 相対)。BFF 内部実行 (serve) が指定する。
   * 省略時はエージェントの bash として要求 cwd から導出される。
   */
  writeScope?: SandboxWriteScopeEntry[];
  /**
   * この実行の子プロセスへ足す環境変数。作業フォルダの「変数」と、serve 起動時の「変数 + シークレット」が届く。
   * 値は params (ツール引数) やコマンド文字列には混ぜず、リクエストの別フィールドとして送る。
   */
  env?: Record<string, string>;
  signal?: AbortSignal | undefined;
  onUpdate?: ((partial: { content: unknown; details?: unknown }) => void) | undefined;
}

export interface SandboxExecuteResult {
  content: unknown;
  details?: unknown;
}

/** raw 配信の応答。BFF は status / ヘッダを付け直してストリームをそのまま流す。 */
export interface SandboxRawFile {
  /** 200 (全体) / 206 (部分) / 416 (範囲を満たせない)。416 も `Content-Range` を中継するため例外にしない */
  status: number;
  contentType: string;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: string;
  body: ReadableStream<Uint8Array> | null;
}

/** raw 配信へ中継する要求条件。range は BFF が受けた `Range` ヘッダをそのまま渡す。 */
export interface SandboxRawFileOptions {
  range?: string;
}

/** ダウンロードの応答。ファイル名はサンドボックスが決め、BFF は Content-Disposition ごと中継する。 */
export interface SandboxDownloadFile {
  contentType: string;
  contentDisposition: string;
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

/**
 * スキルインポートの要求。`dryRun` / `replace` は受信した query の生の値・一覧をそのまま渡し、
 * 解釈と検証はサンドボックスに任せる (BFF は raw を中継するだけ)。
 */
export interface SandboxSkillsImportInput {
  body: ReadableStream<Uint8Array> | null;
  /** query の生の値。undefined は param なし (apply) */
  dryRun: readonly string[];
  replace: readonly string[];
  signal?: AbortSignal | undefined;
}

export function createSandboxToolClient(options: SandboxToolClientOptions): SandboxToolClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const token = options.token.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const runtimeInfoTimeoutMs = options.runtimeInfoTimeoutMs ?? SANDBOX_RUNTIME_INFO_TIMEOUT_MS;
  const listenerScanTimeoutMs = options.listenerScanTimeoutMs ?? SANDBOX_LISTENER_SCAN_TIMEOUT_MS;
  if (!baseUrl || !token) {
    throw new Error("Sandbox tool client requires baseUrl and token");
  }
  return {
    execute: (toolName, input) => execute(toolName, input, baseUrl, token, fetchImpl),
    getRuntimeInfo: () => getRuntimeInfo(baseUrl, token, fetchImpl, runtimeInfoTimeoutMs),
    listFiles: (path) => listFiles(path, baseUrl, token, fetchImpl),
    statFile: (path) => statFile(path, baseUrl, token, fetchImpl),
    getGitInfo: (path) => getGitInfo(path, baseUrl, token, fetchImpl),
    listSkills: (dir) => listSkills(dir, baseUrl, token, fetchImpl),
    getSkillFile: (relativePath) => getSkillFile(relativePath, baseUrl, token, fetchImpl),
    createSkillFile: (input) => createSkillFile(input, baseUrl, token, fetchImpl),
    saveSkillFile: (input) => saveSkillFile(input, baseUrl, token, fetchImpl),
    previewSkillDelete: (relativePath) => previewSkillDelete(relativePath, baseUrl, token, fetchImpl),
    deleteSkillFolder: (relativePath, treeVersion) =>
      deleteSkillFolder(relativePath, treeVersion, baseUrl, token, fetchImpl),
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
    readHandoff: (path) => readHandoff(path, baseUrl, token, fetchImpl),
    writeHandoff: (input) => writeHandoff(input, baseUrl, token, fetchImpl),
    rollbackHandoff: (input) => rollbackHandoff(input, baseUrl, token, fetchImpl),
    renameEntry: (path, name) => renameEntry(path, name, baseUrl, token, fetchImpl),
    moveEntry: (from, to) => moveEntry(from, to, baseUrl, token, fetchImpl),
    deleteFile: (path) => deleteFile(path, baseUrl, token, fetchImpl),
    deleteDirectory: (path) => deleteDirectory(path, baseUrl, token, fetchImpl),
    uploadFile: (input) => uploadFile(input, baseUrl, token, fetchImpl),
    exportSkills: () => exportSkills(baseUrl, token, fetchImpl),
    checkSkillsExport: () => checkSkillsExport(baseUrl, token, fetchImpl),
    importSkills: (input) => importSkills(input, baseUrl, token, fetchImpl),
    rawFile: (path, options) => rawFile(path, options, baseUrl, token, fetchImpl),
    readImageInput: (path, scope, signal) => readImageInput(path, scope, signal, baseUrl, token, fetchImpl),
    downloadEntry: (path, excludeNames) => downloadEntry(path, excludeNames, baseUrl, token, fetchImpl),
    checkDownload: (path, excludeNames) => checkDownload(path, excludeNames, baseUrl, token, fetchImpl),
    planDownload: (path, excludeNames, maxFileBytes) =>
      planDownload(path, excludeNames, maxFileBytes, baseUrl, token, fetchImpl),
    scanListeners: (port, options) => scanListeners(port, options, baseUrl, token, fetchImpl, listenerScanTimeoutMs),
    scanListenerRange: (from, to) => scanListenerRange(from, to, baseUrl, token, fetchImpl, listenerScanTimeoutMs),
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

export interface SandboxToolClient extends SandboxRuntimeDiagnostics {
  previewFile(path: string): Promise<SandboxFilePreview>;
  execute(toolName: string, input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
  listFiles(path: string): Promise<SandboxFileListing>;
  /**
   * root 相対の参照が通常ファイルとして実在するかの確認。本文は取得しない (存在確認だけに使う)。
   * 実在は 200、不存在は 404、不正・root 外・通常ファイル以外 (ディレクトリ等) は 400。
   */
  statFile(path: string): Promise<SandboxFileStat>;
  /** root 相対のディレクトリが属する repo のブランチ。repo の外・git が無い環境は branch: null */
  getGitInfo(path: string): Promise<SandboxGitInfo>;
  /** `.agents/skills` 配下の発見 (dir は root 相対)。不存在の dir は 404 */
  listSkills(dir: string): Promise<SandboxSkillsResponse>;
  /**
   * 共通スキル 1 件の編集内容。name / description は SDK の発見結果、body は frontmatter を除いた原文で
   * trim しない。不存在は 404、置き場の外・SKILL.md 以外は 400。
   */
  getSkillFile(relativePath: string): Promise<SandboxSkillFileDetail>;
  /** 共通スキルの新規作成 (既存ディレクトリ / 同名は 409、SDK 検証の失敗は 400) */
  createSkillFile(input: SandboxSkillCreateBody): Promise<SandboxSkillCreateResult>;
  /** 共通スキルの保存。版の不一致は 409、安全に差し替えられない frontmatter は 400 */
  saveSkillFile(input: SandboxSkillSaveBody): Promise<SandboxSkillSaveResult>;
  /** 削除する専用フォルダと treeVersion を取る。取消のために何も変更しない */
  previewSkillDelete(relativePath: string): Promise<SandboxSkillDeletePreview>;
  /** 専用フォルダを配下ごと削除する。treeVersion の不一致は 409 */
  deleteSkillFolder(relativePath: string, treeVersion: string): Promise<void>;
  /** `.agents/skills` の ZIP エクスポート。保存名と `Content-Disposition` はサンドボックスが決める */
  exportSkills(): Promise<SandboxDownloadFile>;
  /** エクスポートの見積り (件数 / 合計サイズ / `.git` の除外)。上限超過は 413 */
  checkSkillsExport(): Promise<SandboxDownloadCheck>;
  /** `.agents/skills` の ZIP インポート。plan / apply で応答の形が違い、両方の検証を通す */
  importSkills(input: SandboxSkillsImportInput): Promise<SandboxSkillsImportResult>;
  createDir(path: string): Promise<SandboxCreateDirResult>;
  /**
   * root 相対の引き継ぎメモ (HANDOFF.md) を読む。専用の上限 (2 MiB) / UTF-8 / バイナリの判定を持ち、
   * 実在しない / 不正パスは 404、上限や形式の違反は 400。プレビューの上限を流用しない。
   */
  readHandoff(path: string): Promise<SandboxHandoffRead>;
  /**
   * root 相対の引き継ぎメモを原子的に先頭追記する。同じ実パスへの並行要求はサンドボックス内で直列化し、
   * 先頭行に `dedupeKey` があれば追記しない (`written: false`)。既存の中身は解釈せずそのまま残す。
   */
  writeHandoff(input: { path: string; section: string; dedupeKey: string }): Promise<SandboxHandoffWrite>;
  /**
   * 新規作成した引き継ぎメモの取り消し。内容が `expected` と一致するときだけ削除し、
   * 照合から削除までを追記と同じ実パス排他の中で行う (背後で進んだ他の追記を巻き戻さない)。
   */
  rollbackHandoff(input: { path: string; expected: string }): Promise<SandboxHandoffRollback>;
  /** root 相対のエントリ (ファイル / ディレクトリ) の名前を変える。同名はサンドボックスが 409 で拒む */
  renameEntry(path: string, name: string): Promise<SandboxRenameResult>;
  /** root 相対のエントリを別の親へ移す。移動先の親は実在が必要で、既存の移動先は 409 で拒む */
  moveEntry(from: string, to: string): Promise<SandboxMoveResult>;
  deleteFile(path: string): Promise<void>;
  /** 配下ごとのディレクトリ削除 (recursive はサンドボックスが true 固定で受ける) */
  deleteDirectory(path: string): Promise<void>;
  uploadFile(input: SandboxUploadInput): Promise<SandboxFileUpload>;
  rawFile(path: string, options?: SandboxRawFileOptions): Promise<SandboxRawFile>;
  /**
   * 画像生成の参照画像を読む。`path` は root 相対、`scope` は BFF が決めた root 相対の許可範囲で、
   * サンドボックスは実パスが範囲内のときだけ返す。形式は BFF が実バイトから判定するため、
   * ここは上限付きで本文を読み切るだけ（206 や途中切断を完成画像として返さない）。
   */
  readImageInput(path: string, scope: readonly string[], signal?: AbortSignal | undefined): Promise<Uint8Array>;
  /** 通常ファイルは生配信、ディレクトリは ZIP。保存名と `Content-Disposition` はサンドボックスが決める */
  downloadEntry(path: string, excludeNames: readonly string[]): Promise<SandboxDownloadFile>;
  /** download と同じ走査の見積り（除外名 / 合計サイズ / エントリ数）。上限超過は 413 で拒否される */
  checkDownload(path: string, excludeNames: readonly string[]): Promise<SandboxDownloadCheck>;
  /**
   * download と同じ走査に、プレビュー用の一覧を足した計画。`maxFileBytes` は個別サイズの申告だけで、
   * 合計 / 件数の上限超過は check と同じく 413 で拒否される。
   */
  planDownload(path: string, excludeNames: readonly string[], maxFileBytes?: number): Promise<SandboxDownloadPlan>;
  /**
   * 指定ポートの待受 inode と、`scan: true` のときだけ所有 PID を返す。serve の所有者照合が使う。
   * bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めないため、service 本体が走査する。
   */
  scanListeners(port: number, options: { scan: boolean }): Promise<SandboxListenerScan>;
  /**
   * `from`..`to` の待受ポート一覧。待受の無いポートは返らず、所有 PID の fd 走査もしないため、
   * 状態表示のポーリングに使える。
   */
  scanListenerRange(from: number, to: number): Promise<SandboxListenerRangeScan>;
}

/** /api/files とプロジェクト作成・アップロードが使うサンドボックス機能 (テストはこれを stub に差し替える)。 */ export type SandboxWorkspaceClient =
  Pick<
    SandboxToolClient,
    | "listFiles"
    | "statFile"
    | "getGitInfo"
    | "listSkills"
    | "createDir"
    | "renameEntry"
    | "deleteFile"
    | "deleteDirectory"
    | "previewFile"
    | "uploadFile"
    | "rawFile"
    | "downloadEntry"
    | "checkDownload"
  >;

/**
 * 共通スキル (`.agents/skills`) の GUI CRUD が使うサンドボックス機能。一覧 (listSkills) は既存の
 * workspace の狭い IF が担うためここには含めず、CRUD を使わない既存の stub へ必須メソッドを足さない。
 */
export type SandboxSkillFileClient = Pick<
  SandboxToolClient,
  "getSkillFile" | "createSkillFile" | "saveSkillFile" | "previewSkillDelete" | "deleteSkillFolder"
>;

/**
 * 共有のプレビュー (plan) が使うサンドボックス機能。workspace の狭い IF を広げないよう型を分ける
 * (preview を使わない既存のスタブへ planDownload を要求しない)。
 */
export type SandboxDownloadPlanClient = Pick<SandboxToolClient, "planDownload">;

/**
 * スキルのエクスポート / インポートが使うサンドボックス機能。GUI CRUD の stub を広げないよう型を分ける
 * (インポートは raw body を中継するため、bodyGuard より前のルートからだけ使う)。
 */
export type SandboxSkillArchiveClient = Pick<SandboxToolClient, "exportSkills" | "checkSkillsExport" | "importSkills">;

/**
 * セッションの引っ越し (作業フォルダ / 添付の移動) が使うサンドボックス機能。workspace のスタブを
 * 広げないよう型を分ける (親ディレクトリの作成は workspace 側の createDir を使う)。
 */
export type SandboxMoveClient = Pick<SandboxToolClient, "moveEntry">;

/**
 * 引き継ぎのメモ (HANDOFF.md) の読み取りと書込みが使うサンドボックス機能。
 * 移動のスタブを広げないよう型を分ける。
 */
export type SandboxHandoffClient = Pick<SandboxToolClient, "readHandoff" | "writeHandoff" | "rollbackHandoff">;

/**
 * serve の記録の読み書きと起動・停止が使うサンドボックス機能。workspace のスタブへ execute を
 * 要求しないよう型を分ける。使うのは既存のツール実行と、待受プロセスの観測だけ。
 */
export type SandboxExecClient = Pick<SandboxToolClient, "execute">;

/** 待受プロセスの観測 (serve の所有者照合と空きポートの採番) が使うサンドボックス機能 */
export type SandboxProcessScanClient = Pick<SandboxToolClient, "scanListeners" | "scanListenerRange">;

/** serve が使うサンドボックス機能。実行と観測の両方を満たすものを注入する */
export type SandboxServeClient = SandboxExecClient & SandboxProcessScanClient;

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
 * JSON 経路の HTTP エラーの写像。サンドボックス由来の 4xx (不正パス・不存在・同名の競合) は文言ごと透過し、
 * 認証失敗とサンドボックス側障害は 502 に寄せる。
 */
async function jsonError(response: Response, label: string): Promise<SandboxRequestError> {
  const detail = errorDetailOf(await response.text().catch(() => ""));
  if (response.status === 401 || response.status === 403) {
    return new SandboxRequestError("サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)", 502);
  }
  if (response.status === 400 || response.status === 404 || response.status === 409) {
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

async function getGitInfo(
  path: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxGitInfo> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/git?path=${encodeURIComponent(path)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "git 情報を取得できませんでした");
  return (await response.json()) as SandboxGitInfo;
}

/**
 * 単一ファイルの存在確認。通常ファイルとして実在するときだけ 200 で、404 (不存在) / 400 (不正・root 外・
 * 通常ファイル以外) はそのまま透過する。本文は取得しない (テキスト固有の 400 を存在の判定に混ぜない)。
 */
async function statFile(
  path: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxFileStat> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/stat?path=${encodeURIComponent(path)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "ファイルを確認できませんでした");
  return (await response.json()) as SandboxFileStat;
}

/**
 * 待受観測 (`GET /v1/procs/listeners`) の取得。期限は接続と本文の両方に掛ける: fetch や本文読み取りが
 * signal を無視する実装でも待ち続けない。
 */
async function requestListenerScan<T>(
  query: URLSearchParams,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(new Error("サンドボックスの待受観測がタイムアウトしました"));
  }, timeoutMs);
  try {
    const response = await Promise.race([
      fetchJson(
        fetchImpl,
        `${baseUrl}/v1/procs/listeners?${query.toString()}`,
        { headers: jsonHeaders(token), signal: controller.signal },
        baseUrl,
      ),
      timeout,
    ]);
    if (!response.ok) {
      throw await Promise.race([jsonError(response, "待受プロセスの観測に失敗しました"), timeout]);
    }
    return await Promise.race([response.json() as Promise<T>, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 待受ソケットと所有 PID の観測。`scan` は停止と起動の確認でだけ true にする (重い fd 走査を避ける)。
 */
async function scanListeners(
  port: number,
  options: { scan: boolean },
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SandboxListenerScan> {
  const query = new URLSearchParams({ port: String(port), scan: String(options.scan) });
  return await requestListenerScan<SandboxListenerScan>(query, baseUrl, token, fetchImpl, timeoutMs);
}

/** レンジの待受ポート一覧。待受ゼロのポートはサンドボックス側で落とされる。 */
async function scanListenerRange(
  from: number,
  to: number,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SandboxListenerRangeScan> {
  const query = new URLSearchParams({ from: String(from), to: String(to) });
  return await requestListenerScan<SandboxListenerRangeScan>(query, baseUrl, token, fetchImpl, timeoutMs);
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

/**
 * root 相対のエントリの名前を変える。成功の応答は改名後の root 相対パスで、同名の競合 (409) は文言ごと透過する。
 */
async function renameEntry(
  path: string,
  name: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxRenameResult> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/rename`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ path, name }),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "名前を変更できませんでした");
  return (await response.json()) as SandboxRenameResult;
}

/**
 * root 相対のエントリを別の親へ移す。成功の応答は移動後の root 相対パスで、既存の移動先 (409) は文言ごと透過する。
 */
async function moveEntry(
  from: string,
  to: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxMoveResult> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/move`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "移動できませんでした");
  return (await response.json()) as SandboxMoveResult;
}

/** 引き継ぎメモの読取り。404 (不存在) と 400 (上限・形式) は文言ごと透過する */
async function readHandoff(
  path: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxHandoffRead> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/handoff?path=${encodeURIComponent(path)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "引き継ぎメモを読めませんでした");
  return (await response.json()) as SandboxHandoffRead;
}

/**
 * 引き継ぎメモの先頭追記。読んで書く全体をサンドボックス側の排他の中で行う (BFF は組み立てた節だけを渡す)。
 */
async function writeHandoff(
  input: { path: string; section: string; dedupeKey: string },
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxHandoffWrite> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/handoff`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "引き継ぎメモを書けませんでした");
  return (await response.json()) as SandboxHandoffWrite;
}

/**
 * 新規作成した引き継ぎメモの取り消し。照合はサンドボックス側の実パス排他の中で行われ、
 * 内容が変わっていれば消さずに `deleted: false` を返す。
 */
async function rollbackHandoff(
  input: { path: string; expected: string },
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxHandoffRollback> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/handoff/rollback`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "引き継ぎメモを取り消せませんでした");
  return (await response.json()) as SandboxHandoffRollback;
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

/**
 * 共通スキル (`.agents/skills`) の編集内容。relativePath は一覧の root 相対パスに揃える。
 * 保存できない場合は editable: false と reason が入るので、呼び出し側は失敗として扱う。
 */
async function getSkillFile(
  relativePath: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxSkillFileDetail> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/file?relativePath=${encodeURIComponent(relativePath)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "スキルの内容を取得できませんでした");
  return (await response.json()) as SandboxSkillFileDetail;
}

/** 共通スキルの新規作成。既存ディレクトリ / 同名の共通スキルは 409 で拒否される */
async function createSkillFile(
  input: SandboxSkillCreateBody,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxSkillCreateResult> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/file`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "スキルを作成できませんでした");
  return (await response.json()) as SandboxSkillCreateResult;
}

/** 共通スキルの保存。版の不一致 (409) と安全に差し替えられない frontmatter (400) は文言ごと透過する */
async function saveSkillFile(
  input: SandboxSkillSaveBody,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxSkillSaveResult> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/file`,
    {
      method: "PATCH",
      headers: { ...jsonHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "スキルを保存できませんでした");
  return (await response.json()) as SandboxSkillSaveResult;
}

/** 削除確認。取消は副作用なしで、ここでは何も変更しない */
async function previewSkillDelete(
  relativePath: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxSkillDeletePreview> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/file/delete-preview?relativePath=${encodeURIComponent(relativePath)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "削除する内容を確認できませんでした");
  return (await response.json()) as SandboxSkillDeletePreview;
}

/**
 * 共通スキルの専用フォルダ削除。treeVersion の一致を要求し、成功は 204 で本文が無いため JSON は読まない。
 * body は使わずクエリだけで渡す (既存の DELETE と同じ流儀)。
 */
async function deleteSkillFolder(
  relativePath: string,
  treeVersion: string,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const query = new URLSearchParams({ relativePath, treeVersion });
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/file?${query.toString()}`,
    { method: "DELETE", headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await jsonError(response, "スキルを削除できませんでした");
}

/** スキルのエクスポート。保存名・Content-Type・長さはサンドボックスが決め、BFF はヘッダを付け直して中継する */
async function exportSkills(baseUrl: string, token: string, fetchImpl: typeof fetch): Promise<SandboxDownloadFile> {
  const response = await fetchJson(fetchImpl, `${baseUrl}/v1/skills/export`, { headers: jsonHeaders(token) }, baseUrl);
  if (!response.ok) throw await rawError(response, "スキルをエクスポートできませんでした");
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  return {
    contentType: response.headers.get("content-type") ?? "application/zip",
    contentDisposition: response.headers.get("content-disposition") ?? "attachment",
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    body: response.body,
  };
}

/** エクスポートの事前チェック (404 / 413 は文言ごと透過する) */
async function checkSkillsExport(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxDownloadCheck> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/export/check`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "エクスポートの確認ができませんでした");
  return (await response.json()) as SandboxDownloadCheck;
}

/**
 * スキルのインポート。raw の ZIP をストリームで送り、bodyGuard を通さない。
 * 400 / 404 / 413 は文言ごと透過し、接続失敗・サンドボックス側障害は 502 に寄せる。
 */
async function importSkills(
  input: SandboxSkillsImportInput,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxSkillsImportResult> {
  const params = new URLSearchParams();
  for (const value of input.dryRun) params.append("dryRun", value);
  for (const name of input.replace) params.append("replace", name);
  const query = params.toString();
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/skills/import${query ? `?${query}` : ""}`,
    {
      method: "POST",
      headers: { ...jsonHeaders(token), "Content-Type": "application/zip" },
      body: input.body,
      // Node の fetch はストリーム body に duplex: "half" を要求する
      duplex: "half",
      signal: input.signal,
    } as RequestInit,
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "スキルをインポートできませんでした");
  return (await response.json()) as SandboxSkillsImportResult;
}

/**
 * 画像 / 音声の生配信。range を渡すとサンドボックスが単一レンジを解釈して 206 / 416 を返す。
 * 4xx (不正パス・不存在・上限超過) は文言ごと透過するが、416 は `Content-Range` を中継したいので例外にしない。
 */
async function rawFile(
  path: string,
  options: SandboxRawFileOptions | undefined,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxRawFile> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/raw?path=${encodeURIComponent(path)}`,
    { headers: { ...jsonHeaders(token), ...(options?.range === undefined ? {} : { Range: options.range }) } },
    baseUrl,
  );
  if (!response.ok && response.status !== 416) throw await rawError(response, "ファイルを配信できませんでした");
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const contentRange = response.headers.get("content-range");
  const acceptRanges = response.headers.get("accept-ranges");
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    ...(contentRange === null ? {} : { contentRange }),
    ...(acceptRanges === null ? {} : { acceptRanges }),
    body: response.body,
  };
}

/**
 * 参照画像の取得。Content-Length と実受信バイト数の両方で上限を見て、途中で切れた応答を完成画像として返さない。
 */
async function readImageInput(
  path: string,
  scope: readonly string[],
  signal: AbortSignal | undefined,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SANDBOX_IMAGE_INPUT_TIMEOUT_MS);
  const onUserAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onUserAbort, { once: true });
  if (signal?.aborted) onUserAbort();
  try {
    return await readImageInputWithSignal(path, scope, controller.signal, baseUrl, token, fetchImpl, () => timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }
}

/** 期限と中断を 1 つの signal に畳んだ後の本体。途中で切れた応答は完成画像として返さない */
async function readImageInputWithSignal(
  path: string,
  scope: readonly string[],
  signal: AbortSignal,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timedOut: () => boolean,
): Promise<Uint8Array> {
  const params = new URLSearchParams({ path });
  for (const dir of scope) params.append("scope", dir);
  let response: Response;
  try {
    response = await fetchJson(
      fetchImpl,
      `${baseUrl}/v1/files/image-input?${params.toString()}`,
      { headers: jsonHeaders(token), signal },
      baseUrl,
    );
  } catch (error) {
    if (timedOut()) throw new SandboxRequestError("参照画像の読み取りがタイムアウトしました", 504);
    throw error;
  }
  if (response.status !== 200) {
    // 206 / 416 の部分応答は完成画像ではない。本文を捨てて、provider を呼ぶ前に拒否する
    if (response.status === 206 || response.status === 416) {
      await response.body?.cancel().catch(() => {});
      throw new SandboxRequestError(`参照画像は全体応答だけを受け付けます (HTTP ${response.status})`, 502);
    }
    if (!response.ok) throw await rawError(response, "参照画像を読み取れませんでした");
  }
  const tooLarge = (): SandboxRequestError =>
    new SandboxRequestError(`参照画像が大きすぎます（上限 ${IMAGE_INPUT_MAX_BYTES} バイト）`, 413);
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > IMAGE_INPUT_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SandboxRequestError("参照画像の応答に本文がありません", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_INPUT_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut()) throw new SandboxRequestError("参照画像の読み取りがタイムアウトしました", 504);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (Number.isFinite(contentLength) && size !== contentLength) {
    throw new SandboxRequestError("参照画像の受信が途中で終わりました", 502);
  }
  if (size === 0) throw new SandboxRequestError("参照画像が空です", 400);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * ダウンロード（通常ファイルの生配信 / ディレクトリの ZIP）。保存名・Content-Type・長さはサンドボックスが決め、
 * BFF はヘッダを付け直してストリームを中継する。4xx (不正パス・不存在・上限超過) は文言ごと透過する。
 */
async function downloadEntry(
  path: string,
  excludeNames: readonly string[],
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxDownloadFile> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/download?path=${encodeURIComponent(path)}&${archiveExcludeQuery(excludeNames)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "ファイルをダウンロードできませんでした");
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  return {
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    // 名前を落とすと日本語名が化けるため、ヘッダはそのまま中継する
    contentDisposition: response.headers.get("content-disposition") ?? "attachment",
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    body: response.body,
  };
}

/** 事前チェック。download と同じ 4xx (413 を含む) を文言ごと透過し、応答は JSON として読む。 */
async function checkDownload(
  path: string,
  excludeNames: readonly string[],
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxDownloadCheck> {
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/download/check?path=${encodeURIComponent(path)}&${archiveExcludeQuery(excludeNames)}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "ダウンロードの確認ができませんでした");
  return (await response.json()) as SandboxDownloadCheck;
}

/**
 * 計画 (plan)。download / check と同じ 4xx (413 を含む) を文言ごと透過し、応答は JSON として読む。
 * `maxFileBytes` は省略時は送らない (サンドボックスは「個別サイズを見ない」と解釈する)。
 */
async function planDownload(
  path: string,
  excludeNames: readonly string[],
  maxFileBytes: number | undefined,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SandboxDownloadPlan> {
  const maxFileBytesQuery = maxFileBytes === undefined ? "" : `&maxFileBytes=${maxFileBytes}`;
  const response = await fetchJson(
    fetchImpl,
    `${baseUrl}/v1/files/download/plan?path=${encodeURIComponent(path)}&${archiveExcludeQuery(excludeNames)}${maxFileBytesQuery}`,
    { headers: jsonHeaders(token) },
    baseUrl,
  );
  if (!response.ok) throw await rawError(response, "公開される内容を確認できませんでした");
  return (await response.json()) as SandboxDownloadPlan;
}

/**
 * 除外名の query を組む。**空リストでも `exclude=` を 1 つ送る**（サンドボックスは param なしを「BFF 未指定」
 * = 既定と見るため、明示空を「除外なし」として伝えるには空値の param が要る）。
 */
function archiveExcludeQuery(excludeNames: readonly string[]): string {
  const params = new URLSearchParams();
  if (excludeNames.length === 0) params.append("exclude", "");
  else for (const name of excludeNames) params.append("exclude", name);
  return params.toString();
}

/**
 * raw 経路のエラー写像。413 (上限超過) は raw 固有なので、JSON 経路 (jsonError) とは分けて透過する。
 * ダウンロードと事前チェックも同じ経路（本文を JSON に載せない応答と 413）を通る。
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

/**
 * 実行環境の診断。接続待ちだけでなく本文の受信完了まで期限を適用し、期限超過は timeout に分類する
 * (unreachable / probe_failed と混同しない)。
 */
async function getRuntimeInfo(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SandboxRuntimeInfo> {
  const controller = new AbortController();
  let rejectTimeout: ((error: SandboxRuntimeError) => void) | undefined;
  // fetch / 本文読み取りが signal を無視しても期限で抜けられるよう、拒否を race で重ねる
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(new SandboxRuntimeError("サンドボックスの実行環境診断がタイムアウトしました", "timeout"));
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(`${baseUrl}/v1/runtime/info`, { headers: jsonHeaders(token), signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof SandboxRuntimeError) throw error;
      throw new SandboxRuntimeError(
        `サンドボックス (${baseUrl}) に接続できません: ${messageFor(error)}`,
        "unreachable",
      );
    }
    if (response.status === 401 || response.status === 403) {
      cancelBody(response);
      throw new SandboxRuntimeError(
        "サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)",
        "unauthorized",
      );
    }
    if (!response.ok) {
      cancelBody(response);
      throw new SandboxRuntimeError(
        `サンドボックスの実行環境情報を取得できませんでした (HTTP ${response.status})`,
        "probe_failed",
      );
    }
    try {
      return await Promise.race([response.json() as Promise<SandboxRuntimeInfo>, timeout]);
    } catch (error) {
      if (error instanceof SandboxRuntimeError) throw error;
      throw new SandboxRuntimeError("サンドボックスの実行環境の応答が不正です", "probe_failed");
    } finally {
      cancelBody(response);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 本文を読まない経路でも接続を解放する。完了は待たない (cancel() が止まる本文を待つと、
 * 期限で中断しても失敗分類が返らず、画面が再読み込み中のままになる)。
 */
function cancelBody(response: Response): void {
  const body = response.body;
  if (!body) return;
  void body.cancel().catch(() => {});
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
        body: JSON.stringify({
          toolCallId: input.toolCallId,
          params: input.params,
          cwd: input.cwd,
          writeScope: input.writeScope,
          env: input.env,
        }),
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
