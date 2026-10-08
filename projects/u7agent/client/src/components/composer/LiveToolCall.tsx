import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { finishOnAnimationEnd } from "../../lib/animationEnd";
import {
  initialLiveTracker,
  liveToolState,
  trackLiveHolds,
  type LiveToolProgress,
  type LiveToolRow,
  type LiveToolTracker,
} from "../../lib/liveToolCall";
import { formatDurationMs } from "../../lib/usageFormat";
import type { RunStatus, ToolCall } from "../../types";

/** investigate の進捗。現在の活動を 1 行、子の本文末尾をその下に出す (live 専用で復元しない) */
function LiveProgress({ progress }: { progress: LiveToolProgress }) {
  return (
    <div className="flex flex-col gap-0.5 pb-0.5 pl-6.5">
      {progress.activity === "" ? null : <span className="truncate text-ink-faint">{progress.activity}</span>}
      {progress.body === "" ? null : (
        <span className="break-words whitespace-pre-wrap text-ink-ghost">{progress.body}</span>
      )}
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

type ExitingRow = { row: LiveToolRow; holdMs: number };

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
      <LiveRowBody row={item.row} />
    </li>
  );
}

/**
 * 入力欄の直上のライブ表示。実行中のツールを出し、終わった行は最短表示時間だけ残してから畳んで外す
 * (表示条件と畳み方の意図は docs/frontend.md)。読み上げは状態行の活動テキストが担うため視覚専用。
 */
export function LiveToolCall({
  runTools,
  runStatus,
  liveToolIds,
  sessionId,
}: {
  /** 直近 run のツールカード (toolCallId → ToolCall)。挿入順がそのまま走査順になる */
  runTools: Readonly<Record<string, ToolCall>>;
  runStatus: RunStatus;
  /** ライブのツールイベントで観測した toolCallId (`ChatState.liveToolIds`)。復元カードと区別する */
  liveToolIds: string[];
  /** 表示中のセッション。変わったら前のセッションの行を持ち越さない (未作成チャットは undefined) */
  sessionId?: string;
}) {
  const state = useMemo(() => liveToolState(runTools, runStatus), [runTools, runStatus]);
  const liveIds = useMemo(() => new Set(liveToolIds), [liveToolIds]);
  const [exiting, setExiting] = useState<ExitingRow[]>([]);
  const trackerRef = useRef<{ key: string | undefined; tracker: LiveToolTracker } | null>(null);

  useEffect(() => {
    const now = Date.now();
    // セッションが変わると runTools ごと入れ替わる。前のセッションの行を畳む対象に持ち越さない
    const known = trackerRef.current;
    const switched = known === null || known.key !== sessionId;
    const tracker = known !== null && !switched ? known.tracker : initialLiveTracker(runTools);
    const next = trackLiveHolds(tracker, {
      rows: state.rows,
      allRows: state.allRows,
      liveIds,
      now,
    });
    trackerRef.current = { key: sessionId, tracker: next.tracker };
    if (switched) {
      setExiting([]);
      return;
    }
    if (next.holds.length === 0) return;
    setExiting((list) => [
      // 同じ id がもう一度現れたときは、古い抜け中の行を残さない (key 空間は分けたまま)
      ...list.filter((item) => !next.holds.some((hold) => hold.row.id === item.row.id)),
      ...next.holds,
    ]);
  }, [state, runStatus, liveIds, sessionId, runTools]);

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
