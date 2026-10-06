import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { finishOnAnimationEnd } from "../../lib/animationEnd";
import { liveToolState, type LiveToolRow } from "../../lib/liveToolCall";
import type { RunStatus, ToolCall } from "../../types";

/** 行の本文。番号はツール履歴の行番号と同じ桁揃えにする */
function LiveRowBody({ row }: { row: LiveToolRow }) {
  return (
    <div className="flex items-center gap-2 px-2 py-0.5">
      <span className="w-4.5 shrink-0 text-right font-sans text-3xs text-ink-ghost tabular-nums">
        {String(row.index).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1 truncate">{row.summary}</span>
    </div>
  );
}

/**
 * 終わった行。高さを 0 へ畳むアニメーションが終わるまで DOM に残すため、行ごとに effect を持つ
 * (走査順が入れ替わっても取り違えないよう id で外す)。
 */
function LeavingRow({ row, onFinished }: { row: LiveToolRow; onFinished: (id: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // animationend が来ない環境 (動きを止めた設定など) は lib/animationEnd.ts の保険の時間で終わる
    return finishOnAnimationEnd(element, getComputedStyle(element).animationDuration, () =>
      finishedRef.current(row.id),
    );
  }, [row.id]);
  return (
    // key は残っている行と共有するため、抜け中の印を付けて衝突させない
    <li key={`leaving-${row.id}`} ref={ref} className="live-tool-item" data-leaving="true">
      <LiveRowBody row={row} />
    </li>
  );
}

/**
 * 入力欄の直上のライブ表示。実行中のツールだけを出し、終わった行は畳んでから外す
 * (表示条件と演出の意図は docs/frontend.md)。読み上げは状態行の活動テキストが担うため視覚専用。
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
  const [leaving, setLeaving] = useState<LiveToolRow[]>([]);
  const previousRef = useRef(state.rows);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = state.rows;
    const current = new Set(state.rows.map((row) => row.id));
    const gone = previous.filter((row) => !current.has(row.id));
    if (gone.length === 0) return;
    setLeaving((list) => [...list.filter((row) => !gone.some((item) => item.id === row.id)), ...gone]);
  }, [state.rows]);

  const finishLeaving = useCallback((id: string) => {
    setLeaving((list) => list.filter((row) => row.id !== id));
  }, []);

  return (
    // 抜け中の行が残っている間は箱を開いたままにする (先に畳むとアニメーションが切れる)
    <div className="live-tool px-1" data-visible={state.visible || leaving.length > 0}>
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
            {leaving.map((row) => (
              <LeavingRow key={row.id} row={row} onFinished={finishLeaving} />
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
