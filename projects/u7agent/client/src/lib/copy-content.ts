import type { ToolCard } from "../hooks/chatReducer";

export function toolCallCopyText(card: Pick<ToolCard, "name" | "args" | "output">): string {
  const lines = [`tool: ${card.name}`];
  if (card.args) lines.push(`args: ${card.args}`);
  if (card.output) lines.push(`output:\n${card.output}`);
  return lines.join("\n");
}

/** UI の行番号と一致するよう通し番号を付ける */
export function toolHistoryCopyText(cards: Pick<ToolCard, "name" | "args" | "output">[]): string {
  return cards.map((card, index) => `#${index + 1} ${toolCallCopyText(card)}`).join("\n\n");
}
