/**
 * ツール履歴の行サマリー。ライブのカード行と、外側 `<details>` を畳んだときのサマリーで同じ関数を使う。
 * スキル読み込みはバッジ側で見せるため、呼び出し側が nonSkillToolCards() で外してから渡す。
 */
import type { ToolCard } from "../hooks/chatReducer";

const TOOL_SUMMARY_MAX_LENGTH = 96;

function truncateSummary(summary: string): string {
  if (summary.length <= TOOL_SUMMARY_MAX_LENGTH) return summary;
  return `${summary.slice(0, TOOL_SUMMARY_MAX_LENGTH - 1)}…`;
}

export function abbreviatedToolSummary(card: Pick<ToolCard, "name" | "args">): string {
  const summary = `${card.name}${card.args ? ` — ${card.args}` : ""}`.replace(/\s+/g, " ").trim();
  return truncateSummary(summary || "ツール");
}

export function historyPreview(cards: ToolCard[]): string {
  if (cards.length === 1) return abbreviatedToolSummary(cards[0]);
  const names = cards.slice(0, 3).map((card) => card.name || "ツール");
  const remainder = cards.length > names.length ? ` ほか${cards.length - names.length}件` : "";
  return `${names.join(" / ")}${remainder}`;
}

/** ツール履歴に並べるカード。進行中のターンだけ実行中のカードを外す (規則は docs/frontend.md) */
export function completedToolCards(cards: readonly ToolCard[]): ToolCard[] {
  return cards.filter((card) => card.phase !== "running");
}
