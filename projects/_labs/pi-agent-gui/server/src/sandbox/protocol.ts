/**
 * BFF ⇄ サンドボックス ツール実行API のワイヤ形式。
 *
 * この層は pi SDK の型に依存しない (payload は JSON として直列化可能な
 * ContentBlock / details を unknown で受ける)。BFF 側 client とサンドボックス
 * 側 service の両方から import される。
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

/** 異常終了。エラーメッセージは BFF 側で Error として再送出される。 */
export interface SandboxErrorEvent {
  type: "error";
  message: string;
}

export type SandboxEvent =
  | SandboxStartEvent
  | SandboxUpdateEvent
  | SandboxResultEvent
  | SandboxErrorEvent;

/** サンドボックス ツール実行API の既定ポート (契約値)。 */
export const SANDBOX_DEFAULT_PORT = 8080;

/** ツール実行要求ボディの上限 (write ツールのファイル内容などを想定)。 */
export const SANDBOX_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** POST /v1/tools/:tool/execute のリクエストボディ。 */
export interface SandboxExecuteRequestBody {
  /** BFF 側 SDK のツール呼び出し ID (出力対応付け用)。省略時は払い出す。 */
  toolCallId?: string;
  /** ツール引数。SDK 側でスキーマ検証済みの値が届く。 */
  params?: Record<string, unknown>;
}

/** NDJSON を 1 行 JSON として直列化する (空行・改行は 1 イベント = 1 行)。 */
export function encodeSandboxEvent(event: SandboxEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** 1 行を SandboxEvent として解釈する。壊れていれば例外。 */
export function decodeSandboxEvent(line: string): SandboxEvent {
  const parsed = JSON.parse(line) as SandboxEvent;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new Error("Malformed sandbox event");
  }
  return parsed;
}
