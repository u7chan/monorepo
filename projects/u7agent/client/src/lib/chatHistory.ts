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

export interface HistoryMergeResult extends HistoryBundle {
  /** ページが保持分と繋がらず、欠落区間の取得が必要 (true のとき bubbles 等は prev のまま) */
  gap: boolean;
  /** 消費した送信エコーを除いた待ち行列 */
  pendingEchoIds: number[];
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
    ...(call.questions ? { questions: call.questions } : {}),
    ...(call.answers ? { answers: call.answers } : {}),
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
    ...(item.runId !== undefined ? { runId: item.runId } : {}),
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

/** 保持中の履歴 item の id (古い→新しい)。ページ間の連続性検証に使う */
export function heldHistoryIds(bubbles: Bubble[], markers: CompactionMarker[]): string[] {
  const ids: string[] = [];
  for (const item of orderedItems(
    bubbles.filter((bubble) => bubble.entryId !== undefined),
    markers,
  )) {
    if (item.bubble?.entryId !== undefined) ids.push(item.bubble.entryId);
    else if (item.marker) ids.push(item.marker.id);
  }
  return ids;
}

/** 保持中の最新の履歴 item id。ローカルエコーの「送信時点で既知だった位置」に使う */
export function newestHistoryItemId(bubbles: Bubble[], markers: CompactionMarker[]): string | undefined {
  return heldHistoryIds(bubbles, markers).at(-1);
}

/**
 * since より後に並ぶ履歴 item の id 集合。since が undefined なら全件。since が見つからない
 * (分岐が変わった等で位置を特定できない) ときは空にして、誤った吸収をしない。
 */
export function historyIdsAfter(
  bubbles: Bubble[],
  markers: CompactionMarker[],
  since: string | undefined,
): Set<string> {
  const ids = heldHistoryIds(bubbles, markers);
  if (since === undefined) return new Set(ids);
  const index = ids.indexOf(since);
  return new Set(index === -1 ? [] : ids.slice(index + 1));
}

type Connection = { kind: "apply"; keepBubbles: number; keepMarkers: CompactionMarker[] } | { kind: "gap" };

/** items の position まで (自身を含む) を保持する接続結果 */
function keptUpTo(items: { bubble?: Bubble; marker?: CompactionMarker }[], position: number): Connection {
  const kept = position < 0 ? [] : items.slice(0, position + 1);
  return {
    kind: "apply",
    keepBubbles: kept.filter((item) => item.bubble !== undefined).length,
    keepMarkers: kept.flatMap((item) => (item.marker ? [item.marker] : [])),
  };
}

/**
 * ページが保持分と繋がるかを prevCursor で判定する。prevCursor はページ先頭の直前の item id なので、
 * 保持中にあれば「そこまで残してページで置き換える」、null ならブランチ先頭 (保持分は現行に無い)、
 * 見つからなければ欠落区間 (別タブで limit 以上追記された / 分岐が変わった) として取り直す。
 * prevCursor が無くてもページ先頭が保持中の item なら重なりとみなす (同じ最新ページの再同期で
 * gap と誤判定しないため)。
 */
function connectionFor(prev: HistoryBundle, page: HistoryPage): Connection {
  const historyBubbles = prev.bubbles.filter((bubble) => bubble.entryId !== undefined);
  // entryId 付きの保持 item が無い = legacy 初期表示 / 履歴を持たない状態。legacy の区切りは
  // 位置の基準 (entryId) が無いので、marker の有無に関わらず最新ページをそのまま適用する
  if (historyBubbles.length === 0) {
    return { kind: "apply", keepBubbles: 0, keepMarkers: [] };
  }
  if (page.items.length === 0) {
    // 最新ページが空 = 現行ブランチに item が無い。保持分は現行に無いので捨てる
    return { kind: "apply", keepBubbles: 0, keepMarkers: [] };
  }
  const items = orderedItems(historyBubbles, prev.markers);
  const positionOf = (id: string | null): number =>
    id === null ? -1 : items.findIndex((item) => (item.bubble?.entryId ?? item.marker?.id) === id);
  const beforePage = positionOf(page.prevCursor);
  if (beforePage !== -1) return keptUpTo(items, beforePage);
  const pageStart = positionOf(page.items[0].id);
  if (pageStart !== -1) return keptUpTo(items, pageStart - 1);
  if (page.prevCursor === null) return { kind: "apply", keepBubbles: 0, keepMarkers: [] };
  return { kind: "gap" };
}

/**
 * ライブバブルと item の同一性。送信の run id が分かるバブルは runId の一致で厳密に対応付ける
 * (別クライアントの同一文面 entry を自分のエコーと誤認しない)。どちらかに run id が無いときは
 * 従来どおり role + 正規形の本文で突き合わせる (旧サーバー / 対応を失った履歴への縮退)。
 */
function matchesLive(bubble: Bubble, item: HistoryItem): boolean {
  if (item.kind !== "message" || item.role !== bubble.role) return false;
  if (bubble.runId !== undefined && item.runId !== undefined) return bubble.runId === item.runId;
  // 未送信 / 受理済み (まだ entry になっていない送信) は本文の縮退に使わない。別クライアントの
  // 同一文面 entry へ黙って吸収させず、自分の run の entry が現れたときだけ runId 一致で置き換える
  if (bubble.unsent || bubble.accepted) return false;
  return canonicalUserText(item.text) === canonicalUserText(bubble.text);
}

/**
 * ライブバブルを、新しく入った item の列と突き合わせる。本文の集合ではなく、role と同一性
 * (run id、無ければ正規形の本文) が一致する item を後ろから順に対にするので、過去に同じ文面が
 * あっても新規送信のエコーを消さない。返す consumed の分だけバブルと pendingEchoIds を落とす。
 */
function reconcileLive(live: Bubble[], items: HistoryItem[]): { kept: Bubble[]; consumed: Set<number> } {
  const consumed = new Set<number>();
  const usedItemIds = new Set<string>();
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const bubble = live[index];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (usedItemIds.has(item.id) || !matchesLive(bubble, item)) continue;
      consumed.add(bubble.id);
      usedItemIds.add(item.id);
      break;
    }
  }
  return { kept: live.filter((bubble) => !consumed.has(bubble.id)), consumed };
}

/**
 * pending の送信エコーのうち、新しい領域に自分の run の item (同じ runId) が載ったものを吸収する。
 * pending は他クライアントの同一文面 entry と区別できないため、run id が一致する item だけを対象に
 * する (run id が無い item は、後段の `consumePendingFallback` が文書化済みの縮退で扱う)。
 */
function absorbPendingEchoes(pendingLives: Bubble[], items: HistoryItem[]): Set<number> {
  const consumed = new Set<number>();
  for (const bubble of pendingLives) {
    if (bubble.runId === undefined) continue;
    if (items.some((item) => item.kind === "message" && item.runId === bubble.runId)) consumed.add(bubble.id);
  }
  return consumed;
}

/**
 * run 対応を失った履歴 (item に runId が載らない) への縮退の突き合わせ。サーバー再起動で実行時の
 * 対応表が消えた item は、runId を持つ item (別 run の entry) と区別できないため、文書化済みの
 * 契約どおり role + 本文の正規形と、送信時点で既知だった位置 (`since`) より後という条件でだけ
 * 対応付ける。`since` が見つからないときは何も返さない (誤った吸収をしない)。
 */
export function fallbackEchoTarget(bubbles: Bubble[], markers: CompactionMarker[], echo: Bubble): Bubble | undefined {
  // 未送信 / 受理済み (サーバーが状態を明示している送信) は本文の縮退に使わない。新しく payload から
  // 作ったバブルは `since` が無く全保持履歴が候補になるため、旧 entry へ黙って吸収され得る
  if (echo.unsent || echo.accepted) return undefined;
  const after = historyIdsAfter(bubbles, markers, echo.since);
  const text = canonicalUserText(echo.text);
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (bubble.entryId === undefined || bubble.role !== "user") continue;
    if (bubble.runId !== undefined) continue;
    if (!after.has(bubble.entryId)) continue;
    if (canonicalUserText(bubble.text) !== text) continue;
    return bubble;
  }
  return undefined;
}

/**
 * 残った pending エコーを、run 対応を失った履歴 item と突き合わせて吸収する。1 item につき
 * 1 エコーだけを消費し、対応のないエコーは末尾に残す。
 */
function consumePendingFallback(bubbles: Bubble[], markers: CompactionMarker[], pendingLives: Bubble[]): Set<number> {
  const consumed = new Set<number>();
  const usedTargets = new Set<number>();
  for (const echo of pendingLives) {
    const target = fallbackEchoTarget(bubbles, markers, echo);
    if (target === undefined || usedTargets.has(target.id)) continue;
    usedTargets.add(target.id);
    consumed.add(echo.id);
  }
  return consumed;
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

/**
 * live を「保持分より手前 (carried)」と「保持分より後ろ (最新ターン / 送信直後)」に分ける。
 * prev に含まれない live (テストや rebuild が別に渡す分) は手前扱い。未送信 / 受理済みは履歴の位置に
 * 関わらず末尾へ置く (まだ履歴 item になっていない送信で、保持分より手前に混ぜると位置が逆転する)。
 */
function splitLive(prev: HistoryBundle, live: Bubble[]): { front: Bubble[]; tail: Bubble[] } {
  const firstHistory = prev.bubbles.findIndex((bubble) => bubble.entryId !== undefined);
  const front: Bubble[] = [];
  const tail: Bubble[] = [];
  for (const bubble of live) {
    const index = prev.bubbles.indexOf(bubble);
    if (bubble.unsent === true || bubble.accepted === true) tail.push(bubble);
    else if (firstHistory !== -1 && index > firstHistory) tail.push(bubble);
    else front.push(bubble);
  }
  return { front, tail };
}

/**
 * resync 相当のマージ。最新ページで「新しい側」だけを差し替え、ページ先頭より古い取得済みページは残す。
 * ページが保持分と繋がらない (gap) ときは適用せず、呼び出し側が欠落区間を取ってから再適用する。
 * ライブバブルはページの新しい領域と一致した分だけ落とし、carried になった分は保持分の手前、
 * 送信直後のローカルエコーと保持分より後のタンは末尾へ置く。
 */
export function mergeHistoryPage(
  prev: HistoryBundle,
  page: HistoryPage,
  { live = [], pendingEchoIds = [] }: { live?: Bubble[]; pendingEchoIds?: number[] } = {},
): HistoryMergeResult {
  const connection = connectionFor(prev, page);
  if (connection.kind === "gap") {
    return { ...prev, gap: true, pendingEchoIds };
  }
  const historyBubbles = prev.bubbles.filter((bubble) => bubble.entryId !== undefined);
  const heldIds = new Set(heldHistoryIds(prev.bubbles, prev.markers));
  const kept = historyBubbles.slice(0, connection.keepBubbles);
  const pageBundle = historyItemsToBundle(prev.nextId, page.items);
  const newItems = page.items.filter((item) => !heldIds.has(item.id));
  const pending = new Set(pendingEchoIds);
  // pending のローカルエコーは他クライアントの同一文面 entry と区別できないため、run id が一致する
  // item (自分の run の entry) だけを吸収に使う
  const pendingLives = live.filter((bubble) => pending.has(bubble.id));
  const otherLives = live.filter((bubble) => !pending.has(bubble.id));
  const consumedPending = absorbPendingEchoes(pendingLives, newItems);
  const keptPending = pendingLives.filter((bubble) => !consumedPending.has(bubble.id));
  const { front, tail } = splitLive(prev, otherLives);
  const { kept: remainingFront } = reconcileLive(front, newItems);
  const { kept: remainingTail } = reconcileLive(tail, newItems);
  const carried = remainingFront;
  const trailing = [...remainingTail, ...keptPending];
  const assembled = [...carried, ...kept, ...pageBundle.bubbles, ...trailing];
  const markers = [
    ...connection.keepMarkers.map((marker) => ({ ...marker, index: marker.index + carried.length })),
    ...pageBundle.markers.map((marker) => ({
      ...marker,
      index: marker.index + carried.length + kept.length,
    })),
  ].sort((a, b) => a.index - b.index);
  // まだ残っている pending エコーは、run 対応を失った履歴 item (runId 無し) となら本文の正規形 +
  // `since` の位置条件で突き合わせる。サーバー再起動で実行中の run が消えてもエコーを残さない
  // (runId を持つ別 run の entry は `fallbackEchoTarget` が対象外にする)
  const fallbackConsumed = consumePendingFallback(assembled, markers, keptPending);
  const bubbles =
    fallbackConsumed.size > 0 ? assembled.filter((bubble) => !fallbackConsumed.has(bubble.id)) : assembled;
  const withCounts = applyHistoryCounts(bubbles, page.messageCount, page.summarizedMessageCount);
  return {
    bubbles: withCounts,
    markers,
    nextId: pageBundle.nextId,
    toolBubbleIds: rebuildToolBubbleIds(withCounts),
    gap: false,
    pendingEchoIds: pendingEchoIds.filter((id) => !consumedPending.has(id) && !fallbackConsumed.has(id)),
  };
}

/**
 * 保持分を捨ててページだけで組み直す。欠落区間が 1 ページに収まらない / 分岐が変わったときの
 * 縮退で、表示は現行ブランチの最新ページへ揃う (古いページはスクロールで取り直す)。
 */
export function rebuildHistoryPage(
  prev: HistoryBundle,
  page: HistoryPage,
  options: { live?: Bubble[]; pendingEchoIds?: number[] } = {},
): HistoryMergeResult {
  return mergeHistoryPage({ bubbles: [], markers: [], nextId: prev.nextId, toolBubbleIds: {} }, page, options);
}

/**
 * 古いページの前置き。既に持っている item は捨て、重なったページを二度足さない。
 * carried になっているライブバブル (legacy 初期表示の残りなど) も、追加分の item と role + 正規形の
 * 順序で突き合わせて消費する。残りは追加分より古いので手前へ戻し、送信直後のエコーだけ末尾に残す。
 * 追加した件数を prependSeq として返し、ChatArea がスクロール位置の補正に使う。
 */
export function prependHistoryPage(
  prev: HistoryBundle & { messageCount: number; summarizedMessageCount: number },
  page: HistoryPage,
  { pendingEchoIds = [] }: { pendingEchoIds?: number[] } = {},
): HistoryBundle & { prepended: number; pendingEchoIds: number[] } {
  const known = new Set<string>();
  for (const bubble of prev.bubbles) if (bubble.entryId !== undefined) known.add(bubble.entryId);
  for (const marker of prev.markers) known.add(marker.id);
  const fresh = page.items.filter((item) => !known.has(item.id));
  const historyBubbles = prev.bubbles.filter((bubble) => bubble.entryId !== undefined);
  // 保持分より手前のライブ (legacy 初期表示の残り / 再構築で carried になった分) だけを追加分と
  // 突き合わせる。保持分より後ろのライブ (送信直後のエコー / 完結した最新ターン) は末尾に残す
  const frontLives: Bubble[] = [];
  const tailLives: Bubble[] = [];
  let seenHistory = false;
  for (const bubble of prev.bubbles) {
    if (bubble.entryId !== undefined) {
      seenHistory = true;
      continue;
    }
    // 未送信 / 受理済みは古いページを前置きしても末尾に残す
    if (bubble.unsent === true || bubble.accepted === true) tailLives.push(bubble);
    else if (seenHistory) tailLives.push(bubble);
    else frontLives.push(bubble);
  }
  if (fresh.length === 0) {
    return { ...prev, prepended: 0, pendingEchoIds };
  }
  const bundle = historyItemsToBundle(prev.nextId, fresh);
  const pending = new Set(pendingEchoIds);
  // pending のエコーは追加分の古い item と突き合わせない (run id が一致する自分の entry だけ吸収する)。
  // 保持分より手前の pending は、run_start 前でも保持分の手前へ戻さず末尾に残す
  const frontPending = frontLives.filter((bubble) => pending.has(bubble.id));
  const tailPending = tailLives.filter((bubble) => pending.has(bubble.id));
  const { kept: remainingFront } = reconcileLive(
    frontLives.filter((bubble) => !pending.has(bubble.id)),
    fresh,
  );
  const consumedPending = absorbPendingEchoes([...frontPending, ...tailPending], fresh);
  const front = remainingFront;
  const keepTail = (bubble: Bubble): boolean => !pending.has(bubble.id) || !consumedPending.has(bubble.id);
  const tail = [...frontPending.filter(keepTail), ...tailLives.filter(keepTail)];
  const shift = bundle.bubbles.length + front.length;
  const bubbles = [...front, ...bundle.bubbles, ...historyBubbles, ...tail];
  const markers = [
    ...bundle.markers.map((marker) => ({ ...marker, index: marker.index + front.length })),
    ...prev.markers.map((marker) => ({ ...marker, index: marker.index + shift })),
  ].sort((a, b) => a.index - b.index);
  const withCounts = applyHistoryCounts(bubbles, page.messageCount, page.summarizedMessageCount);
  return {
    bubbles: withCounts,
    markers,
    nextId: bundle.nextId,
    toolBubbleIds: { ...bundle.toolBubbleIds, ...prev.toolBubbleIds },
    prepended: bundle.bubbles.length,
    pendingEchoIds: pendingEchoIds.filter((id) => !consumedPending.has(id)),
  };
}
