// 表示仕様は docs/compaction.md を正とする (locale に依存させない)
import type { CompactionInfo } from "../types";
import { formatTokens } from "./usageFormat";

const REASON_LABELS: Record<string, string> = {
  manual: "手動",
  threshold: "自動",
  overflow: "上限超過",
};

export function compactionReasonLabel(reason?: string): string | undefined {
  if (!reason) return undefined;
  return REASON_LABELS[reason] ?? reason;
}

export function compactionDividerLabel(compaction: Pick<CompactionInfo, "reason" | "tokensBefore">): string {
  const from = `${formatTokens(compaction.tokensBefore)} tokens から`;
  const reason = compactionReasonLabel(compaction.reason);
  return `ここで会話を圧縮しました（${reason ? `${reason}: ${from}` : from}）`;
}

export function compactionSummaryHeading(compaction: CompactionInfo, index: number): string {
  const parts = [`${index + 1}回目`];
  const reason = compactionReasonLabel(compaction.reason);
  if (reason) parts.push(reason);
  parts.push(`${formatTokens(compaction.tokensBefore)} tokens`);
  return parts.join(" · ");
}

export function compactionHistoryLabel(count: number): string | undefined {
  return count > 1 ? `この会話は ${count} 回圧縮されました` : undefined;
}

/**
 * 区切りを置く bubbles の index (この index の手前、末尾なら messages.length)。
 * 位置を持つのは最新の 1 件だけなので、それ以外は undefined を返して区切りを出さない。
 */
export function compactionDividerIndex(compactions: CompactionInfo[]): number | undefined {
  const index = compactions[compactions.length - 1]?.beforeMessageIndex;
  return typeof index === "number" && index >= 0 ? index : undefined;
}
