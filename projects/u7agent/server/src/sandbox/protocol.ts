/**
 * BFF ⇄ サンドボックスのツール実行 API のワイヤ形式。BFF 側 client とサンドボックス側 service の両方が import するため、
 * pi SDK の型には依存せず payload を unknown で受ける。
 */

/** 実行開始。executionId はサンドボックスが払い出し、cancel で使う。 */
export interface SandboxStartEvent {
  type: "start";
  executionId: string;
}

/** 途中出力。SDK ツールの onUpdate (累積スナップショット) をそのまま relay する。 */
export interface SandboxUpdateEvent {
  type: "update";
  payload: { content?: unknown; details?: unknown };
}

/** 正常終了。SDK ツールの AgentToolResult 相当。 */
export interface SandboxResultEvent {
  type: "result";
  payload: { content: unknown; details?: unknown };
}

/** 異常終了。message は BFF 側で Error として再送出される。 */
export interface SandboxErrorEvent {
  type: "error";
  message: string;
}

export type SandboxEvent = SandboxStartEvent | SandboxUpdateEvent | SandboxResultEvent | SandboxErrorEvent;

/** サンドボックス ツール実行 API の既定ポート (契約値) */
export const SANDBOX_DEFAULT_PORT = 8080;

/** write ツールのファイル内容などを想定したリクエストボディの上限。 */
export const SANDBOX_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** POST /v1/tools/:tool/execute のリクエストボディ。 */
export interface SandboxExecuteRequestBody {
  /** BFF 側 SDK のツール呼び出し ID (出力対応付け用)。省略時は払い出す。 */
  toolCallId?: string;
  /** ツール引数。SDK 側でスキーマ検証済みの値が届く。 */
  params?: Record<string, unknown>;
  /** 実行する作業ディレクトリ (rootCwd 相対)。省略・空文字は root。root 外は 400。 */
  cwd?: string;
}

/** POST /v1/dirs のリクエストボディ。path は rootCwd 相対。 */
export interface SandboxCreateDirRequestBody {
  path: string;
}

/** POST /v1/dirs の応答。path は作成した実ディレクトリの root 相対の正規化パス (root は ".")。 */
export interface SandboxCreateDirResult {
  path: string;
}

/** POST /v1/files/rename のリクエストボディ。path は root 相対のエントリ (ファイル / ディレクトリ)、name は 1 セグメント。 */
export interface SandboxRenameRequestBody {
  path: string;
  name: string;
}

/** POST /v1/files/rename の応答。path は名前を変えたエントリの root 相対の正規化パス (root は ".")。 */
export interface SandboxRenameResult {
  path: string;
  name: string;
}

/** DELETE /v1/dirs の `recursive` query の解釈結果。省略は false で、不正値と重複は ok: false になる */
export type RecursiveQuery = { ok: true; recursive: boolean } | { ok: false };

/**
 * `recursive` query は正確に文字列 `"true"` のときだけ再帰。省略時は空ディレクトリだけを消す。
 * それ以外の値と重複値は「再帰しない」ではなく不正 (400) にする必要があるため、BFF とサンドボックスでこの関数を共有する。
 */
export function parseRecursiveQuery(values: string[] | undefined): RecursiveQuery {
  if (!values || values.length === 0) return { ok: true, recursive: false };
  if (values.length === 1 && values[0] === "true") return { ok: true, recursive: true };
  return { ok: false };
}

/** 不正な `recursive` の説明。BFF とサンドボックスで同じ本文を返す */
export const RECURSIVE_QUERY_ERROR = 'recursive must be exactly "true" when present';

/**
 * 一覧の 1 エントリ。type は symlink を辿った実体の種別で、ディレクトリ以外は file に寄せる。
 * size は実体を stat できたファイルに、mtime は実体を stat できたエントリに付ける (ディレクトリにも付く)。
 */
export interface SandboxFileEntry {
  name: string;
  type: "file" | "dir";
  /** lstat が symlink のとき true (type は辿った先の種別) */
  symlink?: boolean;
  /** stat できたファイルだけ。ディレクトリの size はファイルの内容量を表さないため付けない */
  size?: number;
  /** epoch ms。壊れた symlink には付けない */
  mtime?: number;
}

/**
 * GET /v1/files の応答。path は一覧した実ディレクトリの root 相対の正規化パス (root は ".") で、
 * symlink を経由した要求では辿った先のパスになる (type と同じく実体で表す)。
 */
export interface SandboxFileListing {
  path: string;
  entries: SandboxFileEntry[];
  /** 1 ディレクトリの上限で打ち切ったか */
  truncated: boolean;
}

/** 1 ディレクトリあたりの上限 (SDK の ls ツールの既定上限に揃える) */
export const SANDBOX_MAX_FILE_ENTRIES = 500;

/**
 * GET /v1/skills の 1 件。走査規則 (hidden / node_modules / ignore ファイル / frontmatter 検証) は
 * SDK の loadSkillsFromDir に委譲し、ここでは SKILL.md だけを返す。
 * path は realpath (= root 内の絶対パス) で、symlink を解決した実体を指す (read 時の内容と一致させる)。
 */
export interface SandboxSkillEntry {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
}

/** GET /v1/skills の応答。同じ実体へ解決する重複 (symlink / 循環リンク) は path ごとに 1 件へ畳む */
export interface SandboxSkillsResponse {
  skills: SandboxSkillEntry[];
}

/** GET /v1/files/preview の応答。UTF-8 へデコード済みのテキスト。 */

export interface SandboxFilePreview {
  text: string;
}

/**
 * GET /v1/files/download/check の応答。download と同じ走査（除外 / symlink / 上限）の結果を返し、
 * ブラウザに生 JSON を見せずに理由をツリー内へ出すための事前チェック。
 */
export interface SandboxDownloadCheck {
  /** file = 単体ファイルの生配信、archive = ディレクトリの ZIP */
  kind: "file" | "archive";
  /** 保存名。ファイルはその名前、ZIP は `<フォルダ名>.zip` */
  name: string;
  /** 含まれるファイルの合計サイズ（単体ファイルはそのサイズ）。単体ファイルも ZIP と同じ上限で拒否する */
  bytes: number;
  /** ZIP のエントリ数（単体ファイルは 0） */
  entries: number;
  /** 除外規則で落とした名前（重複なし・規則の順） */
  skipped: string[];
}

/** プレビューで読むファイルサイズの上限 (これより大きいと 400)。 */
export const SANDBOX_MAX_PREVIEW_BYTES = 256 * 1024;

/**
 * アップロード / 生配信の 1 ファイル上限 (100 MiB)。クライアントの申告サイズは信用せず、ここで数える。
 */
export const SANDBOX_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * ダウンロードの合計サイズ上限。Zip64 を書かないため、ZIP も単体ファイルも同じ値で抑える
 * (アップロード / 生配信の上限と同値。4 GiB 未満の通常の ZIP フィールドに収める)。
 */
export const SANDBOX_MAX_ARCHIVE_BYTES = SANDBOX_MAX_UPLOAD_BYTES;

/** ZIP のエントリ数上限。EOCD の件数は 16bit (65,535) なので余裕をもって抑える */
export const SANDBOX_MAX_ARCHIVE_ENTRIES = 10_000;

/** 1 セグメントの名前の上限 (文字数)。アップロードの保存名とリネーム先に使う。 */
export const SANDBOX_MAX_ENTRY_NAME_LENGTH = 200;

/**
 * GET /v1/files/raw が配信する拡張子と Content-Type。SVG / HTML は同一オリジンでスクリプトが動くため載せない。
 */
export const RAW_IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** パスの拡張子から配信用の Content-Type を引く。allowlist 外 (拡張子なし・dotfile 含む) は undefined。 */
export function rawImageContentType(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  // `Object.prototype` の名前 (`.constructor` など) を拡張子に使われても allowlist を通過させない
  if (!Object.hasOwn(RAW_IMAGE_CONTENT_TYPES, extension)) return undefined;
  return RAW_IMAGE_CONTENT_TYPES[extension];
}

/**
 * 1 セグメントの名前 (アップロードの保存名 / リネーム先)。保存先や親は呼び出し側が担うため、
 * 名前からディレクトリを動かせてはならない。
 */
export function isValidEntryName(name: string): boolean {
  if (!name || name.length > SANDBOX_MAX_ENTRY_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // oxlint-disable-next-line no-control-regex -- ファイル名の制御文字を弾くための検出。
  return !/[\u0000-\u001f\u007f]/.test(name);
}

/** POST /v1/files/upload の応答。path は作成した実ファイルの root 相対の正規化パス。 */
export interface SandboxFileUpload {
  path: string;
  /** 実際に保存された名前。同名があった場合は連番つきになる */
  name: string;
  /** 要求名と違う名前で保存されたか */
  renamed: boolean;
  size: number;
}

/** 1 イベント = 1 行。 */
export function encodeSandboxEvent(event: SandboxEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** 壊れた行は例外にする。 */
export function decodeSandboxEvent(line: string): SandboxEvent {
  const parsed = JSON.parse(line) as SandboxEvent;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new Error("Malformed sandbox event");
  }
  return parsed;
}
