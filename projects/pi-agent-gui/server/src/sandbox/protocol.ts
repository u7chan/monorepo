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

export type SandboxEvent =
  | SandboxStartEvent
  | SandboxUpdateEvent
  | SandboxResultEvent
  | SandboxErrorEvent;

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
}

// ---------------------------------------------------------------------------
// GET /v1/files (作業領域の一覧。ツール実行の NDJSON とは別の JSON 経路)
// ---------------------------------------------------------------------------

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
 * GET /v1/files の応答。path は root 相対の正規化パス (root は ".") で、
 * symlink を解決した先ではなく要求された位置を返す。
 */
export interface SandboxFileListing {
  path: string;
  entries: SandboxFileEntry[];
  /** 1 ディレクトリの上限で打ち切ったか */
  truncated: boolean;
}

/** 1 ディレクトリあたりの上限 (SDK の ls ツールの既定上限に揃える) */
export const SANDBOX_MAX_FILE_ENTRIES = 500;

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
