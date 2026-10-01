/**
 * pi の message / tool 構造を表示用の DTO テキストへ写す純関数群。
 * 秘密値のマスクは切り詰めより先に行う (逆順だと上限の境界でキーの末尾が欠け、大部分が生のまま残る)。
 */
import { basename, dirname, resolve } from "node:path";
import { catalogSkillNameFromPath } from "./catalog-skills";
import { SKILL_FILE_NAME } from "./builtin-skills";
import type { PiSessionLike } from "./pi-runtime";
import { parseUsage } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { ChatMessage, MessageMetrics, SkillLoad, ToolCall } from "./schema";

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

/** 表示用の文字列から剥がす前置き。末尾のスラッシュは落として区切りを 1 つに揃える */
function cwdPrefix(cwd: string): string {
  return cwd.replace(/\/+$/, "");
}

/**
 * 構造化されたパスの値用: 値全体が 1 つのパスなので、前置きの一致だけで判定できる。
 * cwd 自身は `.`、cwd 配下は `./` 付きの cwd 相対、cwd の外はそのまま (`<cwd>+backup` のような
 * 接頭辞が同じだけの別のパスを含む)。
 */
export function cwdRelativePath(path: string, cwd: string): string {
  const base = cwdPrefix(cwd);
  if (base === "" || !path.startsWith(base)) return path;
  const rest = path.slice(base.length);
  if (rest === "") return ".";
  return rest.startsWith("/") ? `./${rest.replace(/^\/+/, "")}` : path;
}

export function toolArgsSummary(args: unknown, masker: SecretMasker, cwd: string): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") {
    return `$ ${truncate(masker.mask(record.command), ARGS_TEXT_MAX)}`;
  }
  // 畳むのはツール契約で値がパスと決まっている引数だけにする。本文 (command / output / JSON) の
  // `<cwd>/…` に見える語はパスとは限らず (grep の検索語、case / [ ] の照合語)、`./…` へ書き換えると
  // コピーしたコマンドの挙動が変わる。
  const path = record.path || record.file_path || record.filePath;
  if (typeof path === "string") return cwdRelativePath(masker.mask(path), cwd);
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

/** 表示用メッセージへ写す文脈。履歴ページは表示範囲の外にある toolResult / 繰り上げ元も参照できるよう、
 * 全履歴ぶんの索引と表示範囲を別々に渡す (索引作りは文字列を作らない軽い走査に留める)。 */
export interface MessageProjectionContext {
  toolResults: Map<string, PiSessionLike["messages"][number]>;
  toolErrors: Map<string, boolean>;
  messageMetrics: WeakMap<object, MessageMetrics>;
  masker: SecretMasker;
  cwd: string;
}

/** toolResult は toolCall より後ろに来るため、id で先に結び付ける */
export function messageProjectionContext(
  messages: PiSessionLike["messages"],
  messageMetrics: WeakMap<object, MessageMetrics>,
  masker: SecretMasker,
  cwd: string,
): MessageProjectionContext {
  const { errors, results } = toolResultsOf(messages);
  return { toolResults: results, toolErrors: errors, messageMetrics, masker, cwd };
}

/**
 * [from, to) を履歴順に投影する。from より手前の繰り上げ元は見えないため、呼び出し側は
 * ターンの先頭 (直前の user) まで from を戻す。1 件も表示しないメッセージの tools / skillLoads は
 * 同ターン内の次の表示メッセージへ繰り上げる (件数と表示集合を変えないため)。
 */
export function projectMessagesRange(
  messages: PiSessionLike["messages"],
  context: MessageProjectionContext,
  range: { from?: number; to?: number } = {},
): { index: number; message: ChatMessage }[] {
  const from = Math.max(0, Math.min(messages.length, range.from ?? 0));
  const to = Math.max(from, Math.min(messages.length, range.to ?? messages.length));
  const { messageMetrics, masker, cwd } = context;
  const projected: { index: number; message: ChatMessage }[] = [];
  let carried: SkillLoad[] = [];
  let carriedTools: ToolCall[] = [];
  for (let index = from; index < to; index += 1) {
    const message = messages[index];
    // ターン境界では繰り上げない (次の user メッセージを越えた先へは運ばない)
    if (message.role === "user") {
      carried = [];
      carriedTools = [];
    }
    const loads = message.role === "assistant" ? skillLoadsOf(message, context.toolErrors, cwd, masker) : [];
    const tools = message.role === "assistant" ? toolCallsOf(message, context.toolResults, cwd, masker) : [];
    if (!isDisplayableMessage(message, masker)) {
      carried.push(...loads);
      carriedTools.push(...tools);
      continue;
    }
    const text = masker.mask(contentText(message.content));
    const usage = message.role === "assistant" ? parseUsage(message.usage) : undefined;
    const metrics = messageMetrics.get(message);
    const skillLoads = [...carried, ...loads];
    const projectedTools = [...carriedTools, ...tools];
    carried = [];
    carriedTools = [];
    projected.push({
      index,
      message: {
        role: message.role as "user" | "assistant",
        text,
        stopReason: message.role === "assistant" ? message.stopReason : undefined,
        // SDK が timestamp を持たない履歴 (旧セッション / スタブ) では at キー自体を作らない
        ...(typeof message.timestamp === "number" ? { at: message.timestamp } : {}),
        ...(usage ? { usage } : {}),
        ...(metrics ? { metrics } : {}),
        ...(projectedTools.length > 0 ? { tools: projectedTools } : {}),
        ...(skillLoads.length > 0 ? { skillLoads } : {}),
      },
    });
  }
  return projected;
}

export function projectMessages(
  session: PiSessionLike,
  messageMetrics: WeakMap<object, MessageMetrics>,
  masker: SecretMasker,
  cwd: string,
): ChatMessage[] {
  const context = messageProjectionContext(session.messages, messageMetrics, masker, cwd);
  return projectMessagesRange(session.messages, context).map(({ message }) => message);
}

function toolResultsOf(messages: PiSessionLike["messages"]): {
  results: Map<string, PiSessionLike["messages"][number]>;
  errors: Map<string, boolean>;
} {
  const results = new Map<string, PiSessionLike["messages"][number]>();
  const errors = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    results.set(message.toolCallId, message);
    errors.set(message.toolCallId, message.isError === true);
  }
  return { results, errors };
}

function toolCallsOf(
  message: PiSessionLike["messages"][number],
  toolResults: Map<string, PiSessionLike["messages"][number]>,
  cwd: string,
  masker: SecretMasker,
): ToolCall[] {
  if (!Array.isArray(message.content)) return [];
  const calls: ToolCall[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
    if (classifySkillRead(call.arguments, { cwd, toolName: call.name })) continue;
    const result = toolResults.get(call.id);
    if (!result) continue;
    calls.push({
      id: call.id,
      name: call.name,
      args: toolArgsSummary(call.arguments, masker, cwd),
      isError: result.isError === true,
      done: true,
      output: toolResultSummary(result, masker),
    });
  }
  return calls;
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
    // ルート直下の SKILL.md は親ディレクトリ名が空になるため、pi と同じくファイル名へ落とす。
    // カタログの仮想パスはセグメントが percent encoding 済みなので、表示用の名前に戻す
    name: catalogSkillNameFromPath(path) ?? (basename(dirname(path)) || fileName),
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
