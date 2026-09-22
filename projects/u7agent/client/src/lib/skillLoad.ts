/**
 * スキル読み込みバッジの表記と、履歴 (ChatMessage.skillLoads) / ライブ (ToolCard.skill) の統合。
 * 同じ出来事が文脈によってカード行とバッジのどちらかになると二重に見えるため、整形と選別はここ 1 箇所に置く。
 */
import type { Bubble, ToolCard } from "../hooks/chatReducer";
import type { SkillLoad } from "../types";

/** pi の formatReadLineRange() と同じ表記。offset 省略は 1 行目、limit 省略は最終行までを意味する */
export function formatReadLineRange(offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return "";
  const startLine = offset ?? 1;
  const endLine = limit !== undefined ? startLine + limit - 1 : "";
  return `:${startLine}${endLine ? `-${endLine}` : ""}`;
}

export function skillLoadSummary(load: Pick<SkillLoad, "name" | "offset" | "limit">): string {
  return `[skill] ${load.name}${formatReadLineRange(load.offset, load.limit)}`;
}

/**
 * バッジの状態。ライブはカードの位相、履歴は isError から決める。実行中は成功 / 失敗の
 * どちらでもない (結果がまだ届いていない) ため、完了ともエラーとも別の状態にする。
 */
export type SkillBadgeState = "running" | "done" | "failed";

export type SkillBadge = {
  load: SkillLoad;
  state: SkillBadgeState;
  /** 失敗理由 (ライブのカード出力の1行)。履歴だけの失敗では取れないので、表示側が「読み込み失敗」を出す */
  reason?: string;
};

/** カード出力の先頭の非空行。理由1行だけを見せる (全文はスキル本文ではなく実行ログのため) */
function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function badgeOf(load: SkillLoad, card: ToolCard | undefined): SkillBadge {
  if (card?.phase === "running") return { load, state: "running" };
  if (card?.phase === "failed" || load.isError) {
    const reason = card ? firstNonEmptyLine(card.output) : undefined;
    return reason ? { load, state: "failed", reason } : { load, state: "failed" };
  }
  return { load, state: "done" };
}

/**
 * バブル id ごとのバッジ。表示位置は履歴 (ChatMessage.skillLoads) を正とし、履歴に無いライブ分だけを
 * カードのあるバブルへ出す。resync では run の toolCall が最後のバブルへまとまって付くため、
 * 同じ toolCallId の重複排除は 1 つのバブルではなく全バブル横断で行う。
 */
export function skillBadgesOf(bubbles: readonly Bubble[]): Map<number, SkillBadge[]> {
  const cards = new Map<string, ToolCard>();
  for (const bubble of bubbles) {
    for (const card of bubble.tools) cards.set(card.id, card);
  }
  const inHistory = new Set<string>();
  for (const bubble of bubbles) {
    for (const load of bubble.skillLoads) inHistory.add(load.id);
  }
  const badges = new Map<number, SkillBadge[]>();
  for (const bubble of bubbles) {
    const items = bubble.skillLoads.map((load) => badgeOf(load, cards.get(load.id)));
    for (const card of bubble.tools) {
      if (card.skill && !inHistory.has(card.id)) items.push(badgeOf(card.skill, card));
    }
    badges.set(bubble.id, items);
  }
  return badges;
}

/**
 * スキル読み込みは入出力を持つ操作ではないのでバッジ側で見せ、ツール履歴の件数・サマリー・
 * コピー本文からは外す (コピー本文の #N を UI の行番号と一致させ続けるため、両者で同じ関数を通す)。
 */
export function nonSkillToolCards(cards: readonly ToolCard[]): ToolCard[] {
  return cards.filter((card) => !card.skill);
}
