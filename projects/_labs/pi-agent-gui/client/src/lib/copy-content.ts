import type { ToolCard } from "../hooks/chatReducer";

/** ツールコールをクリップボードへコピーする際のテキストに整形する */
export function toolCallCopyText(card: Pick<ToolCard, "name" | "args" | "output">): string {
  const lines = [`tool: ${card.name}`];
  if (card.args) lines.push(`args: ${card.args}`);
  if (card.output) lines.push(`output:\n${card.output}`);
  return lines.join("\n");
}
