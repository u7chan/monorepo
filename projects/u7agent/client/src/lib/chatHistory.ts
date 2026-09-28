// 全履歴ページを chat のバブル列へ写す純関数。resync (最新ページで新しい側だけ差し替え) と
// 上方向の追加取得 (古い側を前置き) を同じ表現で扱い、entry id で重複排除する。
// スクロール位置の維持は ChatArea 側の責務で、ここでは順序と状態だけを決める。
import { splitAttachedFiles } from "./attachments";
import type { Bubble, CompactionMarker, ToolCard } from "./chatTypes";
import { skillCommandForm } from "./skillBlock";
import type { HistoryItem, HistoryPage, ToolCall } from "../types";

export interface HistoryBundle {
  bubbles: Bubble[];
  markers: CompactionMarker[];
  nextId: number;
  toolBubbleIds: Record<string, number>;
}

/**
 * 送信エコーの照合用の正規形。添付の注記を落とし、`/skill:` の展開結果は打ったコマンドの形へ戻す。
 * ローカルエコー (素の入力) と履歴 / run_start (展開済みの本文) を同じ形に寄せるために使う。
 */
export function canonicalUserText(text: string): string {
  return skillCommandForm(splitAttachedFiles(text).text);
}

/** 履歴の導出値を写し忘れると resync でツール履歴やバッジが黙って消える */
export function toolCardOf(call: ToolCall): ToolCard {
  return {
    id: call.id,
    name: call.name,
    args: call.args,
    phase: call.done ? (call.isError ? "failed" : "done") : "running",
    output: call.output,
    ...(call.skill ? { skill: call.skill } : {}),
  };
}

function bubbleOfItem(
  nextId: number,
  item: Extract<HistoryItem, { kind: "message" }>,
  seenToolCallIds: Set<string>,
): Bubble {
  const tools = (item.tools ?? [])
    .filter((call) => {
      if (seenToolCallIds.has(call.id)) return false;
      seenToolCallIds.add(call.id);
      return true;
    })
    .map(toolCardOf);
  return {
    id: nextId,
    entryId: item.id,
    context: item.context,
    role: item.role,
    text: item.text,
    tools,
    skillLoads: item.skillLoads ?? [],
    at: item.at,
    usage: item.usage,
    metrics: item.metrics,
  };
}

/** ページ (古い→新しい) をバブルと区切りへ写す。id は nextId から連番で振る */
export function historyItemsToBundle(nextId: number, items: HistoryItem[]): HistoryBundle {
  const bubbles: Bubble[] = [];
  const markers: CompactionMarker[] = [];
  const toolBubbleIds: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "compaction") {
      markers.push({ id: item.id, index: bubbles.length, compactions: [item.compaction] });
      continue;
    }
    const bubble = bubbleOfItem(nextId, item, seenToolCallIds);
    nextId += 1;
    for (const card of bubble.tools) toolBubbleIds[card.id] = bubble.id;
    bubbles.push(bubble);
  }
  return { bubbles, markers, nextId, toolBubbleIds };
}

/** bubbles と区切りを表示順に並べる (区切りは自分より後ろのバブルとの間に入る) */
function orderedItems(
  bubbles: Bubble[],
  markers: CompactionMarker[],
): { bubble?: Bubble; marker?: CompactionMarker }[] {
  const sorted = [...markers].sort((a, b) => a.index - b.index);
  const items: { bubble?: Bubble; marker?: CompactionMarker }[] = [];
  let cursor = 0;
  for (let position = 0; position <= bubbles.length; position += 1) {
    while (cursor < sorted.length && sorted[cursor].index <= position) {
      items.push({ marker: sorted[cursor] });
      cursor += 1;
    }
    if (position < bubbles.length) items.push({ bubble: bubbles[position] });
  }
  return items;
}

/** item id より手前にあるメッセージバブルの数 (= 保持すべき古い側の件数) */
function bubbleCountBefore(bubbles: Bubble[], markers: CompactionMarker[], id: string): number | undefined {
  let count = 0;
  for (const item of orderedItems(bubbles, markers)) {
    if (item.bubble) {
      if (item.bubble.entryId === id) return count;
      count += 1;
      continue;
    }
    if (item.marker?.id === id) return count;
  }
  return undefined;
}

/**
 * 現行ブランチ全体の件数から summarized の範囲を付け直す。保持しているのは最新側の連続した範囲
 * なので、各履歴バブルの全体 index は「全体件数 − 保持件数 + 順位」で求まる。これで境界を跨いだ
 * 過去ページ (未取得の summarized を含む) も正しく薄暗くできる。
 */
export function applyHistoryCounts(bubbles: Bubble[], messageCount: number, summarizedMessageCount: number): Bubble[] {
  const history = bubbles.filter((bubble) => bubble.entryId !== undefined);
  if (history.length === 0) return bubbles;
  const base = messageCount - history.length;
  let position = 0;
  return bubbles.map((bubble) => {
    if (bubble.entryId === undefined) return bubble;
    const globalIndex = base + position;
    position += 1;
    if (globalIndex < summarizedMessageCount) return { ...bubble, context: "summarized" };
    return bubble.context === undefined ? { ...bubble, context: "active" } : bubble;
  });
}

function rebuildToolBubbleIds(bubbles: Bubble[]): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const bubble of bubbles) {
    for (const card of bubble.tools) {
      if (ids[card.id] === undefined) ids[card.id] = bubble.id;
    }
  }
  return ids;
}

/**
 * resync 相当のマージ。最新ページで「新しい側」だけを差し替え、ページ先頭より古い取得済みページは残す。
 * ライブバブルはユーザーのローカルエコー (送信直後) だけ残し、ストリーミング中の assistant は
 * context_edit の resync と同じく捨てる (完了した本文はページ側に載る)。
 */
export function mergeHistoryPage(
  prev: HistoryBundle,
  page: HistoryPage,
  { live = [], pendingEchoIds = [] }: { live?: Bubble[]; pendingEchoIds?: number[] } = {},
): HistoryBundle {
  const historyBubbles = prev.bubbles.filter((bubble) => bubble.entryId !== undefined);
  const pageStart = page.items[0]?.id;
  let keepCount: number;
  if (pageStart === undefined) {
    keepCount = 0;
  } else {
    const found = bubbleCountBefore(historyBubbles, prev.markers, pageStart);
    // 見つからない = 保持中の全件がページより古い。全件がページに含まれる (hasMore=false) なら残さない
    keepCount = found ?? (page.hasMore ? historyBubbles.length : 0);
  }
  const kept = historyBubbles.slice(0, keepCount);
  const pageBundle = historyItemsToBundle(prev.nextId, page.items);
  const pageIds = new Set(page.items.map((item) => item.id));
  const keptMarkers = prev.markers
    .filter((marker) => marker.index < keepCount && !pageIds.has(marker.id))
    .map((marker) => ({ ...marker, compactions: marker.compactions }));
  // ページに同じ発言が載ったライブバブルは捨てる (entryId 付きの item が正)。ページに載らない
  // 確定済みのライブバブルはページ先頭より古い (resync を跨いだターン) ため、ページの手前へ戻し、
  // 送信直後でまだ entry になっていないローカルエコーだけを末尾へ残す。
  const knownText = (bubble: Bubble): string => `${bubble.role}\u0000${canonicalUserText(bubble.text)}`;
  const knownTexts = new Set([...kept, ...pageBundle.bubbles].map(knownText));
  const pending = new Set(pendingEchoIds);
  const unmatched = live.filter((bubble) => !knownTexts.has(knownText(bubble)));
  const carried = unmatched.filter((bubble) => !pending.has(bubble.id));
  const trailing = unmatched.filter((bubble) => pending.has(bubble.id));
  const bubbles = [...kept, ...carried, ...pageBundle.bubbles, ...trailing];
  const markers = [
    ...keptMarkers,
    ...pageBundle.markers.map((marker) => ({ ...marker, index: marker.index + keepCount + carried.length })),
  ].sort((a, b) => a.index - b.index);
  const withCounts = applyHistoryCounts(bubbles, page.messageCount, page.summarizedMessageCount);
  return {
    bubbles: withCounts,
    markers,
    nextId: pageBundle.nextId,
    toolBubbleIds: rebuildToolBubbleIds(withCounts),
  };
}

/**
 * 古いページの前置き。既に持っている item は捨て、重なったページを二度足さない。
 * 追加した件数を prependSeq として返し、ChatArea がスクロール位置の補正に使う。
 */
export function prependHistoryPage(
  prev: HistoryBundle & { messageCount: number; summarizedMessageCount: number },
  page: HistoryPage,
): HistoryBundle & { prepended: number } {
  const known = new Set<string>();
  for (const bubble of prev.bubbles) if (bubble.entryId !== undefined) known.add(bubble.entryId);
  for (const marker of prev.markers) known.add(marker.id);
  const fresh = page.items.filter((item) => !known.has(item.id));
  if (fresh.length === 0) {
    return { ...prev, prepended: 0 };
  }
  const bundle = historyItemsToBundle(prev.nextId, fresh);
  const shift = bundle.bubbles.length;
  const bubbles = [...bundle.bubbles, ...prev.bubbles];
  const markers = [
    ...bundle.markers,
    ...prev.markers.map((marker) => ({ ...marker, index: marker.index + shift })),
  ].sort((a, b) => a.index - b.index);
  const withCounts = applyHistoryCounts(bubbles, page.messageCount, page.summarizedMessageCount);
  return {
    bubbles: withCounts,
    markers,
    nextId: bundle.nextId,
    toolBubbleIds: { ...bundle.toolBubbleIds, ...prev.toolBubbleIds },
    prepended: bundle.bubbles.length,
  };
}
