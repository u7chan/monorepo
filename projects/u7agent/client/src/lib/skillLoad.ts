/**
 * スキル読み込み行の表記と、ツールカードとの突き合わせ。履歴の吹き出し・ライブのカード行・
 * ツール履歴サマリーの 3 箇所が同じ表記を使うよう、整形はここ 1 箇所に置く。
 */
import type { Bubble } from "../hooks/chatReducer";
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
 * 全バブル横断の toolCallId。resync では run の toolCall が最後のバブルへまとまって付くため、
 * 1 つのバブルだけを見ると同じ呼び出しがカード行と導出行で二重になる。
 */
export function toolCallIdsOf(bubbles: readonly Pick<Bubble, "tools">[]): Set<string> {
  const ids = new Set<string>();
  for (const bubble of bubbles) {
    for (const tool of bubble.tools) ids.add(tool.id);
  }
  return ids;
}

/** カードとして出ている呼び出しの導出行は出さない (bubbles[].tools を正にする) */
export function visibleSkillLoads(
  loads: readonly SkillLoad[] | undefined,
  toolCallIds: ReadonlySet<string>,
): SkillLoad[] {
  return (loads ?? []).filter((load) => !toolCallIds.has(load.id));
}
