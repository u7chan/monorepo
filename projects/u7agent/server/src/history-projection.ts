/**
 * GUI 用の全履歴投影。保存の正は session.jsonl の entry 列のままで、SDK の実行コンテキスト
 * (session.messages) と表示用の履歴を分ける。位置と状態は entry の並びと session.messages の
 * 照合だけで導出し、「最新の compaction より古い = summarized」のような配列 index 依存の判定はしない。
 *
 * ページの切り出しは entry の並びで行い、文字列化 (マスク・切り詰め) は選んだ範囲だけに掛ける。
 * ツール結果の索引と繰り上げ元の走査だけは全履歴を参照する (どちらも文字列を作らない軽い走査)。
 */
import { compactionsFromEntries } from "./compaction-view";
import type { PiSessionEntryLike, PiSessionLike } from "./pi-runtime";
import { branchEntriesOf } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { ChatMessage, HistoryContextState, HistoryItem, HistoryPage } from "./schema";
import type { SessionRecord } from "./session-record";
import { isDisplayableMessage, messageProjectionContext, projectMessagesRange } from "./session-projection";

export const HISTORY_PAGE_LIMIT_DEFAULT = 50;
export const HISTORY_PAGE_LIMIT_MAX = 200;

export type HistoryPageResult = { ok: true; page: HistoryPage } | { ok: false; reason: "unknown-cursor" };

type HistoryMessage = PiSessionLike["messages"][number];

interface MessageItemDescriptor {
  kind: "message";
  id: string;
  entryIndex: number;
  message: HistoryMessage;
  context: HistoryContextState;
}

interface CompactionItemDescriptor {
  kind: "compaction";
  id: string;
  entryIndex: number;
}

type ItemDescriptor = MessageItemDescriptor | CompactionItemDescriptor;

/** SDK が id を持たない旧履歴 (スタブ等) でもページを跨いで同一視できる安定 id */
function entryIdAt(entry: PiSessionEntryLike, index: number): string {
  return typeof entry.id === "string" && entry.id !== "" ? entry.id : `legacy-${index}`;
}

function messageOf(entry: PiSessionEntryLike): HistoryMessage | undefined {
  return entry.type === "message" && entry.message ? (entry.message as HistoryMessage) : undefined;
}

/** 表示対象 (user / 本文のある assistant) と compaction だけを時系列に並べる */
function describeEntries(
  entries: PiSessionEntryLike[],
  session: PiSessionLike,
  masker: SecretMasker,
): ItemDescriptor[] {
  const inContext = new Set<object>(session.messages);
  let latestCompactionIndex = -1;
  entries.forEach((entry, index) => {
    if (entry.type === "compaction") latestCompactionIndex = index;
  });
  // 最新の compaction が保持した範囲の先頭。firstKeptEntryId は metadata entry を指し得るため、
  // メッセージ entry とみなさず「その entry 以降が有効」として位置だけを使う。
  let keepStartIndex = -1;
  if (latestCompactionIndex >= 0) {
    const firstKept = String(entries[latestCompactionIndex].firstKeptEntryId ?? "");
    if (firstKept !== "") {
      keepStartIndex = entries.findIndex((entry, index) => entryIdAt(entry, index) === firstKept);
    }
    if (keepStartIndex < 0) keepStartIndex = latestCompactionIndex;
  }
  const descriptors: ItemDescriptor[] = [];
  entries.forEach((entry, index) => {
    if (entry.type === "compaction") {
      descriptors.push({ kind: "compaction", id: entryIdAt(entry, index), entryIndex: index });
      return;
    }
    const message = messageOf(entry);
    if (!message || !isDisplayableMessage(message, masker)) return;
    const context: HistoryContextState = inContext.has(message)
      ? "active"
      : latestCompactionIndex >= 0 && index < keepStartIndex
        ? "summarized"
        : "excluded";
    descriptors.push({ kind: "message", id: entryIdAt(entry, index), entryIndex: index, message, context });
  });
  return descriptors;
}

/** 表示しないメッセージ (ツール結果など) を挟みつつ、entry の index と messages の index を対応させる */
function buildMessageIndex(entries: PiSessionEntryLike[]): {
  messages: HistoryMessage[];
  entryIndexByMessage: number[];
} {
  const messages: HistoryMessage[] = [];
  const entryIndexByMessage: number[] = [];
  entries.forEach((entry, index) => {
    const message = messageOf(entry);
    if (!message) return;
    messages.push(message);
    entryIndexByMessage.push(index);
  });
  return { messages, entryIndexByMessage };
}

/** entryIndexByMessage が昇順であることを使って、entry index 以上/より大きい最初の messages index を返す */
function lowerBound(entryIndexByMessage: number[], entryIndex: number): number {
  let low = 0;
  let high = entryIndexByMessage.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (entryIndexByMessage[mid] < entryIndex) low = mid + 1;
    else high = mid;
  }
  return low;
}

function projectItems({
  record,
  entries,
  selected,
  startEntryIndex,
  endEntryIndex,
  masker,
  cwd,
}: {
  record: SessionRecord;
  entries: PiSessionEntryLike[];
  selected: ItemDescriptor[];
  startEntryIndex: number;
  endEntryIndex: number;
  masker: SecretMasker;
  cwd: string;
}): HistoryItem[] {
  const { session } = record;
  const { messages, entryIndexByMessage } = buildMessageIndex(entries);
  const context = messageProjectionContext(messages, record.messageMetrics, masker, cwd);
  // 繰り上げ (本文の無い assistant の tools / skillLoads) はターンを跨がないため、直近の user
  // から投影すればページ先頭の項目も同じ結果になる (projected 側ではページ先頭以降だけを拾う)。
  let projectionStartIndex = 0;
  for (let index = startEntryIndex - 1; index >= 0; index -= 1) {
    if (messageOf(entries[index])?.role === "user") {
      projectionStartIndex = index;
      break;
    }
  }
  const startMessage = lowerBound(entryIndexByMessage, projectionStartIndex);
  const endMessage = lowerBound(entryIndexByMessage, endEntryIndex);
  const projected = projectMessagesRange(messages, context, { from: startMessage, to: endMessage });
  const projectedById = new Map<string, ChatMessage>();
  for (const item of projected) {
    if (entryIndexByMessage[item.index] < startEntryIndex) continue;
    const entryIndex = entryIndexByMessage[item.index];
    projectedById.set(entryIdAt(entries[entryIndex], entryIndex), item.message);
  }
  const compactionsById = new Map(
    compactionsFromEntries(entries, session.messages, record.compactionMeta, masker).map((compaction) => [
      compaction.id,
      compaction,
    ]),
  );
  return selected.map((descriptor): HistoryItem => {
    if (descriptor.kind === "compaction") {
      return {
        kind: "compaction",
        id: descriptor.id,
        // compactionsFromEntries は同じ entry 列から組むため必ず引ける (欠落時は空の要約へ縮退)
        compaction: compactionsById.get(descriptor.id) ?? {
          id: descriptor.id,
          parentId: null,
          timestamp: "",
          summary: "",
          firstKeptEntryId: "",
          tokensBefore: 0,
        },
      };
    }
    const item = projectedById.get(descriptor.id);
    return {
      kind: "message",
      id: descriptor.id,
      context: descriptor.context,
      role: item?.role ?? (descriptor.message.role as "user" | "assistant"),
      text: item?.text ?? "",
      ...(item?.stopReason !== undefined ? { stopReason: item.stopReason } : {}),
      ...(item?.at !== undefined ? { at: item.at } : {}),
      ...(item?.usage ? { usage: item.usage } : {}),
      ...(item?.metrics ? { metrics: item.metrics } : {}),
      ...(item?.tools ? { tools: item.tools } : {}),
      ...(item?.skillLoads ? { skillLoads: item.skillLoads } : {}),
    };
  });
}

/**
 * 現行ブランチの履歴ページを組む。`before` はその item より古い範囲を返す排他的カーソルで、
 * 存在しない id は unknown-cursor として呼び出し側で 400 にする。
 */
export function projectHistoryPage({
  record,
  masker,
  cwd,
  before,
  limit = HISTORY_PAGE_LIMIT_DEFAULT,
}: {
  record: SessionRecord;
  masker: SecretMasker;
  cwd: string;
  before?: string;
  limit?: number;
}): HistoryPageResult {
  const { session } = record;
  const entries = branchEntriesOf(session);
  const descriptors = describeEntries(entries, session, masker);
  const messages = descriptors.filter((descriptor) => descriptor.kind === "message");
  const summarizedMessageCount = messages.filter((descriptor) => descriptor.context === "summarized").length;
  const active = messages.find((descriptor) => descriptor.context === "active");
  // 要約で置き換わった範囲が無いときは境界を出さない (全件 active にラベルを付けない)
  const activeContextStartId = summarizedMessageCount > 0 ? (active?.id ?? null) : null;

  let endEntryIndex = entries.length;
  if (before !== undefined) {
    const found = entries.findIndex((entry, index) => entryIdAt(entry, index) === before);
    if (found === -1) return { ok: false, reason: "unknown-cursor" };
    endEntryIndex = found;
  }
  // 古い側へ limit 件 + もう 1 件まで見て hasMore を決める。投影は選んだ範囲にだけ掛ける
  const pageable = descriptors.filter((descriptor) => descriptor.entryIndex < endEntryIndex);
  const window = pageable.slice(Math.max(0, pageable.length - limit - 1));
  const hasMore = window.length > limit;
  const selected = hasMore ? window.slice(window.length - limit) : window;
  const startEntryIndex = selected.length > 0 ? selected[0].entryIndex : endEntryIndex;
  return {
    ok: true,
    page: {
      sessionId: record.id,
      items:
        selected.length > 0
          ? projectItems({ record, entries, selected, startEntryIndex, endEntryIndex, masker, cwd })
          : [],
      nextCursor: hasMore ? selected[0].id : null,
      hasMore,
      activeContextStartId,
      messageCount: messages.length,
      summarizedMessageCount,
    },
  };
}
