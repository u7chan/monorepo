import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { finishOnAnimationEnd } from "../../lib/animationEnd";
import { liveToolState, type LiveToolRow } from "../../lib/liveToolCall";
import { toolDurationMs } from "../../lib/toolTiming";
import { formatDurationMs } from "../../lib/usageFormat";
import type { RunStatus, ToolCall } from "../../types";

/**
 * 行を出してから畳み始めるまでの最短時間。一瞬で終わるツールでも「何が走ったか」を読めるようにする
 * (即座に畳むと、開始のアニメーションの途中で消えて見えない。docs/frontend.md)。
 */
export const LIVE_ROW_MIN_VISIBLE_MS = 900;

/** 行の本文。番号はツール履歴の行番号と同じ桁揃えにする */
function LiveRowBody({ row, durationMs }: { row: LiveToolRow; durationMs?: number }) {
  return (
    <div className="flex items-center gap-2 px-2 py-0.5">
      <span className="w-4.5 shrink-0 text-right font-sans text-3xs text-ink-ghost tabular-nums">
        {String(row.index).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1 truncate">{row.summary}</span>
      {/* 実行時間は終わった行だけに出る (BFF 計測)。出ている間は畳む前の見せている時間になる */}
      {durationMs === undefined ? null : (
        <span className="shrink-0 font-sans text-3xs whitespace-nowrap text-ink-ghost tabular-nums">
          {formatDurationMs(durationMs)}
        </span>
      )}
    </div>
  );
}

type ExitingRow = {
  row: LiveToolRow;
  durationMs?: number;
  /** 最短表示時間の残り。0 ならそのまま畳む */
  holdMs: number;
};

/**
 * 終わった行。最短表示時間までは終わった行としてそのまま出し、そこから高さを 0 へ畳む。畳み終わるまで
 * DOM に残すため、行ごとに effect を持つ (走査順が入れ替わっても取り違えないよう id で外す)。
 */
function ExitingRow({ item, onFinished }: { item: ExitingRow; onFinished: (id: string) => void }) {
  const [leaving, setLeaving] = useState(item.holdMs <= 0);
  const ref = useRef<HTMLLIElement>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    if (leaving) return;
    const timer = window.setTimeout(() => setLeaving(true), item.holdMs);
    return () => window.clearTimeout(timer);
  }, [leaving, item.holdMs]);

  useEffect(() => {
    if (!leaving) return;
    const element = ref.current;
    if (!element) return;
    // animationend が来ない環境 (動きを止めた設定など) は lib/animationEnd.ts の保険の時間で終わる
    return finishOnAnimationEnd(element, getComputedStyle(element).animationDuration, () =>
      finishedRef.current(item.row.id),
    );
  }, [leaving, item.row.id]);

  return (
    <li ref={ref} className="live-tool-item" data-leaving={leaving} data-done={!leaving}>
      <LiveRowBody row={item.row} durationMs={item.durationMs} />
    </li>
  );
}

/**
 * 入力欄の直上のライブ表示。実行中のツールだけを出し、終わった行は最短表示時間だけ残してから
 * 畳んで外す (表示条件と演出の意図は docs/frontend.md)。読み上げは状態行の活動テキストが担うため
 * 視覚専用。
 */
export function LiveToolCall({
  runTools,
  runStatus,
}: {
  /** 直近 run のツールカード (toolCallId → ToolCall)。挿入順がそのまま走査順になる */
  runTools: Readonly<Record<string, ToolCall>>;
  runStatus: RunStatus;
}) {
  const state = useMemo(() => liveToolState(runTools, runStatus), [runTools, runStatus]);
  const [exiting, setExiting] = useState<ExitingRow[]>([]);
  const previousRef = useRef(state.rows);
  /** 行ごとに最初に表示した時刻。最短表示時間の残りを出すために控える */
  const seenRef = useRef(new Map<string, number>());

  useEffect(() => {
    const now = Date.now();
    const previous = previousRef.current;
    previousRef.current = state.rows;
    for (const row of state.rows) {
      if (!seenRef.current.has(row.id)) seenRef.current.set(row.id, now);
    }
    const current = new Set(state.rows.map((row) => row.id));
    const gone = previous.filter((row) => !current.has(row.id));
    if (gone.length === 0) return;
    setExiting((list) => [
      ...list.filter((item) => !gone.some((row) => row.id === item.row.id)),
      ...gone.map((row) => {
        const seen = seenRef.current.get(row.id);
        seenRef.current.delete(row.id);
        return {
          row,
          // 実行時間は BFF 計測。落ちた直後の runTools を引く (running のままの行には無い)
          durationMs: toolDurationMs(runTools[row.id] ?? {}),
          holdMs: Math.max(0, LIVE_ROW_MIN_VISIBLE_MS - (now - (seen ?? now))),
        };
      }),
    ]);
  }, [state.rows, runTools]);

  const finishLeaving = useCallback((id: string) => {
    setExiting((list) => list.filter((item) => item.row.id !== id));
  }, []);

  return (
    // 抜け中の行が残っている間は箱を開いたままにする (先に畳むとアニメーションが切れる)
    <div className="live-tool px-1" data-visible={state.visible || exiting.length > 0}>
      <div>
        {/* 視覚専用。行が無い間は箱ごと畳む (状態行の活動テキストと重ならないようにする) */}
        <div
          aria-hidden="true"
          className="mb-1.5 overflow-hidden rounded-lg border border-accent/25 bg-accent-wash font-mono text-2xs text-ink-muted"
        >
          <div className="flex items-center gap-1.5 border-b border-accent/20 px-2 py-1 text-2xs text-ink-faint">
            <span className="dot dot-accent dot-pulse" />
            ライブ
            <span className="text-ink-ghost">実行中のツール</span>
          </div>
          <ol className="m-0 grid list-none py-0.5">
            {exiting.map((item) => (
              // 同じ id が rows 側にも戻り得るため、抜け中の行は key 空間を分ける
              <ExitingRow key={`leaving-${item.row.id}`} item={item} onFinished={finishLeaving} />
            ))}
            {state.rows.map((row) => (
              <li key={row.id} className="live-tool-item" data-leaving="false">
                <LiveRowBody row={row} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
