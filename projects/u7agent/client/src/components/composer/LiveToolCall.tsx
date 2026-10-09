import { cn } from "../../lib/cn";
import type { LiveToolCallView } from "../../hooks/useLiveToolCall";
import { formatDurationMs } from "../../lib/usageFormat";
import type { LiveToolProgress, LiveToolRow } from "../../lib/liveToolCall";

/** investigate の進捗。現在の活動と子の本文末尾を 1 行ずつ出し、左罫線で行の要約と分ける */
function LiveProgress({ progress }: { progress: LiveToolProgress }) {
  return (
    <div className="ml-5 flex flex-col gap-0.5 border-l border-accent/30 py-0.5 pl-1.5">
      {progress.activity === "" ? null : <span className="truncate text-ink-faint">{progress.activity}</span>}
      {progress.body === "" ? null : <span className="truncate text-ink-ghost">{progress.body}</span>}
    </div>
  );
}

/** 行の本文。番号はツール履歴の行番号と同じ桁揃えにする */
function LiveRowBody({ row }: { row: LiveToolRow }) {
  return (
    <div className="px-2 py-0.5">
      <div className="flex items-center gap-2">
        <span className="w-4.5 shrink-0 text-right font-sans text-3xs text-ink-ghost tabular-nums">
          {String(row.index).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 truncate">{row.summary}</span>
        {/* 実行時間は終わった行だけに出る (BFF 計測)。出ている間は畳む前の見せている時間になる */}
        {row.durationMs === undefined ? null : (
          <span className="shrink-0 font-sans text-3xs whitespace-nowrap text-ink-ghost tabular-nums">
            {formatDurationMs(row.durationMs)}
          </span>
        )}
      </div>
      {row.progress ? <LiveProgress progress={row.progress} /> : null}
    </div>
  );
}

/**
 * 入力欄の直上のライブ表示。実行中のツールを最新の枠まで出し、終わった行はホールドのあいだ残す。
 * 箱は composer のフローへ参加させずに浮かせ、閉じるときだけ行・箱・余白をまとめて畳む。読み上げは
 * 状態行の活動テキストが担うため視覚専用 (段と行の決め方は lib/liveToolCall.ts、意図は docs/frontend.md)。
 */
export function LiveToolCall({
  rows,
  hidden,
  phase,
  className,
}: LiveToolCallView & {
  /** 浮かせる位置 (layout)。見た目はこのコンポーネントが持つ (shadcn/no-restyle) */
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("live-tool", className)}
      data-visible={phase === "open"}
      data-closing={phase === "closing"}
    >
      <div>
        <div className="mb-1.5 overflow-hidden rounded-lg border border-accent/25 bg-panel/95 font-mono text-2xs text-ink-muted shadow-panel backdrop-blur-md">
          <div className="flex items-center gap-1.5 border-b border-accent/20 px-2 py-1 text-2xs leading-4 text-ink-faint">
            <span className="dot dot-accent dot-pulse" />
            ライブ
            <span className="text-ink-ghost">実行中のツール</span>
          </div>
          <ol className="m-0 grid list-none py-0.5">
            {/* 枠から溢れた行は古い順に落とし、読めなかったことは 1 行で示す (行そのものは持たない) */}
            {hidden > 0 ? (
              <li key="others" className="live-tool-row truncate px-2 py-0.5 leading-4 text-ink-ghost">
                …他 {hidden} 件
              </li>
            ) : null}
            {rows.map((row) => (
              <li key={row.id} className="live-tool-row leading-4">
                <LiveRowBody row={row} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
