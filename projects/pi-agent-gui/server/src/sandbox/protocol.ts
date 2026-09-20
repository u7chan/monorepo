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

/**
 * 一覧の 1 エントリ。type は symlink を辿った実体の種別で、ディレクトリ以外は file に寄せる。
 * size / mtime は実体を stat できたファイルにだけ付ける。
 */
export interface SandboxFileEntry {
  name: string;
  type: "file" | "dir";
  /** lstat が symlink のとき true (type は辿った先の種別) */
  symlink?: boolean;
  size?: number;
  /** epoch ms */
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

/** GET /v1/files/preview の応答。UTF-8 へデコード済みのテキスト。 */

export interface SandboxFilePreview {
  text: string;
}

/** プレビューで読むファイルサイズの上限 (これより大きいと 400)。 */
export const SANDBOX_MAX_PREVIEW_BYTES = 256 * 1024;

/**
 * アップロード / 生配信の 1 ファイル上限 (100 MiB)。クライアントの申告サイズは信用せず、ここで数える。
 */
export const SANDBOX_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** アップロードのファイル名の上限 (文字数)。保存名としてだけ使う。 */
export const SANDBOX_MAX_UPLOAD_NAME_LENGTH = 200;

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
 * アップロードの保存名 (basename)。保存先は dir が担うため、名前からディレクトリを動かせてはならない。
 */
export function isValidUploadName(name: string): boolean {
  if (!name || name.length > SANDBOX_MAX_UPLOAD_NAME_LENGTH) return false;
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
