// チャットの描画順と仮想スクロールの見積り・スクロールアンカー補正。
// DOM を使わない純関数だけをここに置き、配線 (virtualizer / scroll ハンドラ) は ChatArea が持つ。
import type { Bubble, CompactionMarker } from "./chatTypes";
import type { CompactionInfo } from "../types";

export type ChatRenderItem =
  | { kind: "message"; key: string; bubble: Bubble }
  | { kind: "compaction"; key: string; index: number; marker: CompactionMarker }
  | { kind: "boundary"; key: string };

export const CONTEXT_BOUNDARY_KEY = "boundary:active-context";

/**
 * 表示順を組む。境界ラベルは「要約済みバブルが実際に読み込まれている」ときだけ、その直前に出す
 * (全件 active や、境界がまだ取れていないページでは出さない)。
 */
export function chatRenderItems({
  bubbles,
  markers,
  compactions,
  activeContextStartId,
}: {
  bubbles: Bubble[];
  markers: CompactionMarker[];
  compactions: CompactionInfo[];
  activeContextStartId: string | null;
}): ChatRenderItem[] {
  const compactionIndexById = new Map(compactions.map((compaction, index) => [compaction.id, index]));
  const markersByPosition = new Map<number, CompactionMarker[]>();
  for (const marker of markers) {
    const list = markersByPosition.get(marker.index) ?? [];
    list.push(marker);
    markersByPosition.set(marker.index, list);
  }
  const boundaryIndex = boundaryPosition(bubbles, activeContextStartId);
  const items: ChatRenderItem[] = [];
  for (let position = 0; position <= bubbles.length; position += 1) {
    if (position === boundaryIndex) items.push({ kind: "boundary", key: CONTEXT_BOUNDARY_KEY });
    for (const marker of (markersByPosition.get(position) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
      items.push({
        kind: "compaction",
        key: `compaction:${marker.id}`,
        marker,
        // 旧 payload の区切りは全要約を 1 か所に並べるため、番号は先頭から振り直す
        index: marker.compactions.length > 1 ? 0 : (compactionIndexById.get(marker.id) ?? 0),
      });
    }
    const bubble = bubbles[position];
    if (bubble) items.push({ kind: "message", key: `message:${bubble.entryId ?? bubble.id}`, bubble });
  }
  return items;
}

/** 境界の直前に summarized のバブルがあるときだけ位置を返す */
function boundaryPosition(bubbles: Bubble[], activeContextStartId: string | null): number | undefined {
  if (!activeContextStartId) return undefined;
  const index = bubbles.findIndex((bubble) => bubble.entryId === activeContextStartId);
  if (index <= 0) return undefined;
  return bubbles.slice(0, index).some((bubble) => bubble.context === "summarized") ? index : undefined;
}

/** 未計測アイテムの初期見積り (px)。値そのものはスクロール位置に使わず、計測までの暫定 */
export function estimateChatItemHeight(item: ChatRenderItem): number {
  if (item.kind === "compaction") return 56;
  if (item.kind === "boundary") return 36;
  const { bubble } = item;
  const textHeight = Math.min(bubble.text.length, 4000) * 0.55;
  const toolHeight = bubble.tools.reduce((total, card) => total + 48 + Math.min(card.output.length, 600) * 0.35, 0);
  const skillHeight = bubble.skillLoads.length * 28;
  return Math.max(72, Math.min(4000, 64 + textHeight + toolHeight + skillHeight));
}

/**
 * 古いページを前置きした後も閲覧位置を保つための scrollTop。プレフィックス分の高さ増加を
 * 現在位置へ足す (scrollTop は先頭基準なので、増えた高さのぶんだけ下へずらす)。
 */
export function anchoredScrollTop({
  anchorTop,
  anchorHeight,
  nextHeight,
}: {
  anchorTop: number;
  anchorHeight: number;
  nextHeight: number;
}): number {
  return Math.max(0, anchorTop + Math.max(0, nextHeight - anchorHeight));
}
