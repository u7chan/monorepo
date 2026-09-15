/**
 * compaction entry を表示用の CompactionInfo へ写す。位置を復元できるのは最新の 1 件だけで、
 * entry に残らない値 (reason / estimatedTokensAfter) は受信時に compactionMeta へ控える。
 */
import type { PiCompactionResult, PiSessionEntryLike, PiSessionEvent, PiSessionLike } from "./pi-runtime";
import { branchEntriesOf, parseUsage } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { CompactionInfo } from "./schema";
import { CompactionReasonSchema } from "./schema";
import type { CompactionMeta, SessionRecord } from "./session-record";
import { isDisplayableMessage } from "./session-projection";

/** compaction entry のうち最後の 1 件の index (context に残るのはこの 1 件だけ) */
function latestCompactionIndex(entries: PiSessionEntryLike[]): number {
  let latest = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].type === "compaction") latest = index;
  }
  return latest;
}

/**
 * 最新の compaction で context に残った古い側の表示メッセージ数 = 区切りを置く messages の index。
 * messages は agent state 由来なので、entry だけで数えると overflow 回復で agent state から
 * 外れたメッセージの分だけずれる。位置は messages 側を数え、entry は「compaction より手前か」
 * の判定にだけ使う。
 */
function keptMessageCount(
  messages: PiSessionLike["messages"],
  entries: PiSessionEntryLike[],
  compactionIndex: number,
  masker: SecretMasker,
): number {
  const entryIndexByMessage = new Map<object, number>();
  entries.forEach((entry, index) => {
    if (entry.type === "message" && entry.message) entryIndexByMessage.set(entry.message, index);
  });
  let count = 0;
  for (const message of messages) {
    const index = entryIndexByMessage.get(message);
    // context 先頭の compactionSummary など、entry に対応しないメッセージは数えない
    if (index === undefined || index >= compactionIndex) continue;
    if (!isDisplayableMessage(message, masker)) continue;
    count += 1;
  }
  return count;
}

/** session.messages ではなく entry を正として圧縮履歴を組む。要約も他の出力と同じくマスクする。 */
function projectCompactions(
  session: PiSessionLike,
  compactionMeta: Map<string, CompactionMeta>,
  masker: SecretMasker,
): CompactionInfo[] {
  const entries = branchEntriesOf(session);
  const compactionIndexes = entries
    .map((entry, index) => (entry.type === "compaction" ? index : -1))
    .filter((index) => index >= 0);
  if (compactionIndexes.length === 0) return [];
  const latestIndex = compactionIndexes[compactionIndexes.length - 1];
  return compactionIndexes.map((entryIndex) => {
    const entry = entries[entryIndex];
    const meta = compactionMeta.get(String(entry.id));
    const usage = parseUsage(entry.usage);
    return {
      id: String(entry.id),
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      summary: masker.mask(typeof entry.summary === "string" ? entry.summary : ""),
      firstKeptEntryId: String(entry.firstKeptEntryId ?? ""),
      tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
      ...(usage ? { usage } : {}),
      ...(entry.fromHook === true ? { fromHook: true } : {}),
      ...(entryIndex === latestIndex
        ? { beforeMessageIndex: keptMessageCount(session.messages, entries, entryIndex, masker) }
        : {}),
      ...(meta?.reason ? { reason: meta.reason } : {}),
      ...(meta?.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: meta.estimatedTokensAfter } : {}),
    };
  });
}

/** record を入力にする版 */
export function compactionsOf(record: SessionRecord, masker: SecretMasker): CompactionInfo[] {
  return projectCompactions(record.session, record.compactionMeta, masker);
}

/**
 * compaction_end の reason / result を最新 entry へ紐づけ、更新後の履歴を返す。
 * SDK は entry を積んで session.messages を組み替えてからこのイベントを出すため、
 * 最新 entry とこの result を同じイベントで紐づけられる。
 * result 無し / aborted / errorMessage ありは何も記録せず undefined を返す
 * (圧縮されていないのに履歴から消えたように見せない)。
 */
export function recordCompactionOutcome({
  session,
  compactionMeta,
  masker,
  event,
}: {
  session: PiSessionLike;
  compactionMeta: Map<string, CompactionMeta>;
  masker: SecretMasker;
  event: PiSessionEvent;
}): CompactionInfo[] | undefined {
  if (event.aborted || event.errorMessage || !event.result) return undefined;
  const entries = branchEntriesOf(session);
  const latestIndex = latestCompactionIndex(entries);
  if (latestIndex < 0) return undefined;
  const result = event.result as PiCompactionResult;
  const reason = CompactionReasonSchema.safeParse(event.reason);
  const estimated = result.estimatedTokensAfter;
  compactionMeta.set(String(entries[latestIndex].id), {
    ...(reason.success ? { reason: reason.data } : {}),
    ...(typeof estimated === "number" ? { estimatedTokensAfter: estimated } : {}),
  });
  const compactions = projectCompactions(session, compactionMeta, masker);
  return compactions.length > 0 ? compactions : undefined;
}
