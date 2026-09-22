/**
 * pi の message / tool 構造を表示用の DTO テキストへ写す純関数群。
 * 秘密値のマスクは切り詰めより先に行う (逆順だと上限の境界でキーの末尾が欠け、大部分が生のまま残る)。
 */
import { basename, dirname, resolve } from "node:path";
import { SKILL_FILE_NAME } from "./builtin-skills";
import type { PiSessionLike } from "./pi-runtime";
import { parseUsage } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { ChatMessage, MessageMetrics, SkillLoad } from "./schema";

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
  cwd: string,
): ChatMessage[] {
  // toolResult は toolCall より後ろに来るため、先に id -> isError を組み立てる (O(n) の線形走査 1 回目)
  const toolErrors = toolErrorsOf(session.messages);
  const messages: ChatMessage[] = [];
  // 本文を持たない assistant (read だけのターン) は表示集合から落ちるため、同ターン内の次の表示メッセージへ
  // 繰り上げる。表示集合と messageCount を変えないための前詰め領域 (2 回目の走査で消費する)。
  let carried: SkillLoad[] = [];
  for (const message of session.messages) {
    // ターン境界では繰り上げない (次の user メッセージを越えた先へは運ばない)
    if (message.role === "user") carried = [];
    const loads = message.role === "assistant" ? skillLoadsOf(message, toolErrors, cwd, masker) : [];
    if (!isDisplayableMessage(message, masker)) {
      carried.push(...loads);
      continue;
    }
    const text = masker.mask(contentText(message.content));
    const usage = message.role === "assistant" ? parseUsage(message.usage) : undefined;
    const metrics = messageMetrics.get(message);
    const skillLoads = [...carried, ...loads];
    carried = [];
    messages.push({
      role: message.role as "user" | "assistant",
      text,
      stopReason: message.role === "assistant" ? message.stopReason : undefined,
      // SDK が timestamp を持たない履歴 (旧セッション / スタブ) では at キー自体を作らない
      ...(typeof message.timestamp === "number" ? { at: message.timestamp } : {}),
      ...(usage ? { usage } : {}),
      ...(metrics ? { metrics } : {}),
      ...(skillLoads.length > 0 ? { skillLoads } : {}),
    });
  }
  return messages;
}

/** toolCallId -> isError。同じ id の result が複数あれば最後を正にする */
function toolErrorsOf(messages: PiSessionLike["messages"]): Map<string, boolean> {
  const errors = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    errors.set(message.toolCallId, message.isError === true);
  }
  return errors;
}

interface SkillReadRef {
  /** 解決後の絶対パス (マスク前) */
  path: string;
  /** 親ディレクトリ名 (マスク前) */
  name: string;
  offset?: number;
  limit?: number;
}

/**
 * read の引数がスキル読み込みかどうかを、ツール名・パスの解決・basename だけで判定する。pi の
 * `getCompactReadClassification()` のうち skill の分だけを持ち、対応するのは絶対 / 相対 / `.` / `..`
 * のみ (`~` 展開・`@` 接頭辞・`file://`・Unicode スペース正規化は非対応)。
 * ツール名の条件をここに置くのは、ライブと履歴のどちらか片方だけが read 以外を通す事故を防ぐため。
 * マスクは呼び出し側の後段で行う: 秘密値に `/` が混ざると basename 判定が壊れ得るため。
 */
export function classifySkillRead(
  args: unknown,
  { cwd, toolName }: { cwd: string; toolName: string },
): SkillReadRef | undefined {
  // write / edit / grep などが path に SKILL.md を持ってもスキル読み込みではない
  if (toolName !== "read") return undefined;
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const rawPath = record.file_path ?? record.path;
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  // ~ 展開・@ 接頭辞・file:// は pi の resolveToCwd 全互換を狙わないため分類しない
  if (rawPath.startsWith("~") || rawPath.startsWith("@") || rawPath.startsWith("file:")) return undefined;
  const path = resolve(cwd, rawPath);
  const fileName = basename(path);
  if (fileName !== SKILL_FILE_NAME) return undefined;
  const ref: SkillReadRef = {
    path,
    // ルート直下の SKILL.md は親ディレクトリ名が空になるため、pi と同じくファイル名へ落とす
    name: basename(dirname(path)) || fileName,
  };
  if (typeof record.offset === "number") ref.offset = record.offset;
  if (typeof record.limit === "number") ref.limit = record.limit;
  return ref;
}

/** 分類済みの read を DTO へ。name / path のマスクは解決 → 分類の後に行う */
export function skillLoadOf({
  id,
  ref,
  masker,
  isError,
}: {
  id: string;
  ref: SkillReadRef;
  masker: SecretMasker;
  isError?: boolean;
}): SkillLoad {
  return {
    id,
    name: masker.mask(ref.name),
    path: masker.mask(ref.path),
    ...(ref.offset !== undefined ? { offset: ref.offset } : {}),
    ...(ref.limit !== undefined ? { limit: ref.limit } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/** assistant メッセージの toolCall part を part 順に見て、スキル読み込みだけを DTO にする */
function skillLoadsOf(
  message: PiSessionLike["messages"][number],
  toolErrors: Map<string, boolean>,
  cwd: string,
  masker: SecretMasker,
): SkillLoad[] {
  if (!Array.isArray(message.content)) return [];
  const loads: SkillLoad[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
    const ref = classifySkillRead(call.arguments, { cwd, toolName: call.name });
    if (!ref) continue;
    const hasResult = toolErrors.has(call.id);
    // 結果が無い read は、abort で一度も実行されていないときだけ発火扱いにしない。それ以外の欠落
    // (crash / restart・compaction 境界) は実行済みなのでロードとして出す。
    if (!hasResult && message.stopReason === "aborted") continue;
    loads.push(skillLoadOf({ id: call.id, ref, masker, isError: hasResult && toolErrors.get(call.id) === true }));
  }
  return loads;
}
