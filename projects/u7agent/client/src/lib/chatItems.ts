// チャットの描画順と仮想スクロールの見積り・スクロールアンカー補正。
// DOM を使わない純関数だけをここに置き、配線 (virtualizer / scroll ハンドラ) は ChatArea が持つ。
import type { Bubble, CompactionMarker } from "./chatTypes";
import type { CompactionInfo } from "../types";
import { generationBadgesOf } from "./generationInfo";
import type { TurnEnd } from "./turnEnd";
import { USER_MESSAGE_CLAMP_PX } from "./userMessage";

export type ChatRenderItem =
  | { kind: "message"; key: string; bubble: Bubble; turnEnd?: TurnEnd }
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
  // 進行中のターン (最後の user バブル)。次の user の手前か末尾で、その 1 つ前のターンを閉じる
  let openTurn: Bubble | undefined;
  // 閉じるターンの結末を付ける先 = そのターンで最後に積んだ表示メッセージ
  let lastMessageIndex: number | undefined;
  for (let position = 0; position <= bubbles.length; position += 1) {
    const bubble = bubbles[position];
    if (bubble === undefined || bubble.role === "user") {
      // 結末はターンを閉じてから付ける。境界ラベル・圧縮の区切りはターンの後ろに並ぶ
      attachTurnEnd(items, lastMessageIndex, openTurn);
      if (bubble) openTurn = bubble;
      lastMessageIndex = undefined;
    }
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
    if (bubble) {
      const turnEnd = itemTurnEnd(bubble);
      // 待機中の送信は transcript に出さない (コンポーザー直上のブロックが担う)。配列を filter せず
      // ここで push だけを見送るのは、marker.index / boundaryPosition / ターンの結末の位置算術を
      // 1 つもずらさないため
      if (bubble.queued !== true) {
        items.push({
          kind: "message",
          key: `message:${bubble.entryId ?? bubble.id}`,
          bubble,
          ...(turnEnd !== undefined ? { turnEnd } : {}),
        });
        lastMessageIndex = items.length - 1;
      }
    }
  }
  return items;
}

/**
 * item 自身が持つ結末。ターンを閉じたかに関係なくその item の結末として描く。schema 上はどの
 * message item にも載り得るため、role と本文ありの検査はここでも残す
 */
function itemTurnEnd(bubble: Bubble): TurnEnd | undefined {
  if (bubble.role !== "assistant" || !bubble.text) return undefined;
  return bubble.turnEnd;
}

/**
 * 閉じたターンの結末を、そのターンで最後に積んだ応答のメタ行へ足す (user バブル由来の導出)。
 * item 自身が結末を持つときは上書きしない。値の無いターン (旧サーバー / 再起動後) と、user entry が
 * 保存されなかったターン (未送信) には足さない。本文を持つ応答だけに足すのは、ツールだけのターンが
 * ライブでは本文の空な assistant バブル (`ensureAssistant`) を持ち、履歴では表示メッセージに
 * ならないため (付けるとライブと履歴で見え方が食い違う)。user 自身のメッセージの下にも出さない:
 * その送信が失敗したように読める。
 */
function attachTurnEnd(items: ChatRenderItem[], index: number | undefined, turn: Bubble | undefined): void {
  if (index === undefined || turn === undefined || turn.unsent === true) return;
  const item = items[index];
  if (item.kind !== "message" || item.turnEnd !== undefined) return;
  if (item.bubble.role !== "assistant" || !item.bubble.text) return;
  const { runDurationMs: durationMs, runOutcome: outcome } = turn;
  if (durationMs === undefined || outcome === undefined) return;
  items[index] = { ...item, turnEnd: { outcome, durationMs } };
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
  // user は収まらないときに折りたたまれるため、見積りの上限が clamp の高さになる
  // (収まる場合の推定はこの上限より小さいまま)
  const estimatedText = Math.min(bubble.text.length, 4000) * 0.55;
  const textHeight = bubble.role === "user" ? Math.min(estimatedText, USER_MESSAGE_CLAMP_PX) : estimatedText;
  const toolHeight = bubble.tools.reduce((total, card) => total + 48 + Math.min(card.output.length, 600) * 0.35, 0);
  // スキル読み込みと生成のバッジは同じ寸法で並ぶため、バッジ 1 件ぶんで数える
  const badges = generationBadgesOf(bubble.tools);
  const badgeCount = bubble.skillLoads.length + badges.length;
  // 生成音声のプレイヤーはブラウザー既定の controls の高さ (実寸は measureElement が補正する)
  const playerCount = badges.filter((badge) => badge.info.kind === "speech" && badge.info.path !== undefined).length;
  return Math.max(72, Math.min(4000, 64 + textHeight + toolHeight + badgeCount * 28 + playerCount * 64));
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
