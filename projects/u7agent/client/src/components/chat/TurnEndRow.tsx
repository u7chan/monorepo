import { cn } from "../../lib/cn";
import { messageColumnClass } from "../../lib/messageColumn";
import { formatTurnDuration, turnOutcomeLabel } from "../../lib/turnEnd";
import type { RunOutcome } from "../../types";

/**
 * ターンの終端 (そのターンの最後の表示 item の直後)。罫線 1 本と右寄せの `Complete · 1m 20s` を
 * 本文と同じ列に出す。値の有無と位置は `chatItems` が決め、ここは見た目だけを持つ。
 */
export function TurnEndRow({
  outcome,
  durationMs,
  summarized = false,
  compact,
}: {
  outcome: RunOutcome;
  durationMs: number;
  /** 要約で置き換わったターンは、そのターンの item と同じく薄暗くする */
  summarized?: boolean;
  compact: boolean;
}) {
  return (
    // 会話のスクロール領域は aria-live="polite" なので、状態行と同じ値の二重読み上げを止める
    // (履歴として後から読める位置には残す)
    <div
      aria-live="off"
      className={cn(
        "mt-2.5 flex min-w-0 items-center gap-2 text-2xs text-ink-faint",
        messageColumnClass(compact),
        summarized ? "opacity-60" : null,
      )}
    >
      <span className="h-px min-w-0 flex-1 bg-line" />
      <span className="shrink-0 font-sans whitespace-nowrap tabular-nums">
        <span lang="en">{turnOutcomeLabel(outcome)}</span> · {formatTurnDuration(durationMs)}
      </span>
      <span className="h-px w-6 shrink-0 bg-line" />
    </div>
  );
}
