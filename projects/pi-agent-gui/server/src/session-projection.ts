/**
 * pi の message / tool 構造を表示用の DTO テキストへ写す純関数群。
 * 秘密値のマスクは切り詰めより先に行う (逆順だと上限の境界でキーの末尾が欠け、大部分が生のまま残る)。
 */
import type { PiSessionLike } from "./pi-runtime";
import { parseUsage } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { ChatMessage, MessageMetrics } from "./schema";

const SUMMARY_TEXT_MAX = 900;
const ARGS_TEXT_MAX = 260;

export function truncate(value: string | undefined | null, length: number): string {
  if (!value) return "";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        part && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => (part as { text: string }).text)
    .join("");
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && (part as { type?: unknown }).type === "image").length;
}

export function toolArgsSummary(args: unknown, masker: SecretMasker): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") {
    return `$ ${truncate(masker.mask(record.command), ARGS_TEXT_MAX)}`;
  }
  const path = record.path || record.file_path || record.filePath;
  if (typeof path === "string") return masker.mask(path);
  try {
    return truncate(masker.mask(JSON.stringify(args)), ARGS_TEXT_MAX);
  } catch {
    return "";
  }
}

export function toolResultSummary(result: unknown, masker: SecretMasker): string {
  // SDK 側の切り詰めで先頭が欠けた場合に備え maskSafe を使う。
  return truncate(masker.maskSafe(contentText((result as { content?: unknown } | null)?.content)), SUMMARY_TEXT_MAX);
}

/**
 * session.messages の表示条件。compaction の区切り位置も同じ集合を数えるため、
 * 位置を数える側と必ず共有する (片方だけ変えると区切りがずれる)。
 */
export function isDisplayableMessage(message: { role: string; content: unknown }, masker: SecretMasker): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  return Boolean(masker.mask(contentText(message.content))) || message.role === "user";
}

/**
 * 表示対象のメッセージを履歴順に返す。本文 (projectMessages) と件数 (一覧 API / 永続化 meta) で
 * 集合が食い違わないよう、判定は isDisplayableMessage だけに持たせる。
 */
export function displayableMessages(session: PiSessionLike, masker: SecretMasker): PiSessionLike["messages"] {
  return session.messages.filter((message) => isDisplayableMessage(message, masker));
}

export function projectMessages(
  session: PiSessionLike,
  messageMetrics: WeakMap<object, MessageMetrics>,
  masker: SecretMasker,
): ChatMessage[] {
  return displayableMessages(session, masker).map((message) => {
    const text = masker.mask(contentText(message.content));
    const images = message.role === "user" ? imageCount(message.content) : 0;
    const usage = message.role === "assistant" ? parseUsage(message.usage) : undefined;
    const metrics = messageMetrics.get(message);
    return {
      role: message.role as "user" | "assistant",
      text,
      ...(images > 0 ? { imageCount: images } : {}),
      stopReason: message.role === "assistant" ? message.stopReason : undefined,
      // SDK が timestamp を持たない履歴 (旧セッション / スタブ) では at キー自体を作らない
      ...(typeof message.timestamp === "number" ? { at: message.timestamp } : {}),
      ...(usage ? { usage } : {}),
      ...(metrics ? { metrics } : {}),
    };
  });
}
