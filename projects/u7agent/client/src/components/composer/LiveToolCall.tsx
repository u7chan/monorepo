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
 * (行は 1 件ずつしか走らないが、走査順が入れ替わっても取り違えないよう id で外す)。
 * `prefers-reduced-motion` では animation が無く animationend が来ないので、保険の時間で終わる
 * (このときは CSS が行ごと消すため、畳む動きは見えない)。
 */
function LeavingRow({ row, onFinished }: { row: LiveToolRow; onFinished: (id: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return finishOnAnimationEnd(element, getComputedStyle(element).animationDuration, () =>
      finishedRef.current(row.id),
    );
  }, [row.id]);
  return (
    <li ref={ref} className="live-tool-item" data-leaving="true">
      <LiveRowBody row={row} />
    </li>
  );
}

/**
 * 入力欄の直上のライブ表示。実行中のツールだけを出し、終わった行は畳んでから外す
 * (完了したカードはツール履歴が持ち、コピーはターンが終わるまで出さない。docs/frontend.md)。
 * 読み上げは状態行の活動テキストが担うため、ここは視覚専用にする。
 */
export function LiveToolCall({
  runTools,
  runStatus,
}: {
  /** 直近 run のツールカード (toolCallId → ToolCall)。順序が走査順になる */
  runTools: Readonly<Record<string, ToolCall>>;
  runStatus: RunStatus;
}) {
  const state = useMemo(() => liveToolState(runTools, runStatus), [runTools, runStatus]);
  const [leaving, setLeaving] = useState<LiveToolRow[]>([]);
  const previousRef = useRef(state.rows);

  // 消えた行を控えておく。箱は抜けきるまで開いたままにする (先に畳むとアニメーションが切れる)
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
    <div className="live-tool px-1" data-visible={state.visible || leaving.length > 0}>
      <div>
        {/* 視覚専用。状態行と同じ内容を繰り返さないよう、行が無い間は箱ごと畳む */}
        <div
          aria-hidden="true"
          className="mb-1.5 overflow-hidden rounded-lg border border-accent/25 bg-accent-wash font-mono text-2xs text-ink-muted"
        >
          <div className="flex items-center gap-1.5 border-b border-accent/20 px-2 py-1 text-2xs text-ink-faint">
            <span className="live-tool-dot" />
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
