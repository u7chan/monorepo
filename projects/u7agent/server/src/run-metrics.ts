import type { ToolCall } from "./schema";
import { askUserWaitTotalMs } from "./wait-total";

type ToolInterval = Pick<ToolCall, "name" | "startedAt" | "endedAt">;

/** 負にしないのは、時計のずれで控除が実時間を超えても表示を壊さないため */
export function runDurationMs({
  startedAt,
  endedAt,
  tools,
}: {
  startedAt: number;
  endedAt: number;
  tools: Iterable<ToolInterval>;
}): number {
  return Math.max(0, endedAt - startedAt - askUserWaitTotalMs(tools, endedAt));
}
