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
