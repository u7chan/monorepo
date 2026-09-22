/**
 * ツール履歴の行サマリー。ライブのカード行と、外側 `<details>` を畳んだときのサマリーで同じ関数を使う。
 * 履歴の吹き出しに出すスキル読み込み行は SkillLoadList が持ち、ここはカードに紐づく分だけを見る。
 */
import type { ToolCard } from "../hooks/chatReducer";
import { skillLoadSummary } from "./skillLoad";

const TOOL_SUMMARY_MAX_LENGTH = 96;

function truncateSummary(summary: string): string {
  if (summary.length <= TOOL_SUMMARY_MAX_LENGTH) return summary;
  return `${summary.slice(0, TOOL_SUMMARY_MAX_LENGTH - 1)}…`;
}

export function abbreviatedToolSummary(card: ToolCard): string {
  // スキル読み込みは引数より行範囲が効く (read の引数は path しか要約されない)
  if (card.skill) return truncateSummary(skillLoadSummary(card.skill));
  const summary = `${card.name}${card.args ? ` — ${card.args}` : ""}`.replace(/\s+/g, " ").trim();
  return truncateSummary(summary || "ツール");
}

export function historyPreview(cards: ToolCard[]): string {
  if (cards.length === 1) return abbreviatedToolSummary(cards[0]);
  // 外側の既定表示はここなので、スキル発火は呼び出し順より優先して先頭に出す
  const skills = cards.flatMap((card) => (card.skill ? [skillLoadSummary(card.skill)] : []));
  const others = cards.filter((card) => !card.skill);
  const names = others.slice(0, 3).map((card) => card.name || "ツール");
  const remainder = others.length > names.length ? ` ほか${others.length - names.length}件` : "";
  return `${[...skills, ...names].join(" / ")}${remainder}`;
}
