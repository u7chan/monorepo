import { useEffect, useMemo, useRef, useState } from "react";
import {
  initialLiveTracker,
  LIVE_CLOSE_MS,
  liveToolHoldRemainingMs,
  liveToolPhase,
  liveToolState,
  liveToolWindow,
  trackLiveHolds,
  type LiveToolHold,
  type LiveToolPhase,
  type LiveToolRow,
  type LiveToolTracker,
} from "../lib/liveToolCall";
import type { RunStatus, ToolCall } from "../types";

export type LiveToolCallView = {
  /** 箱に出す行 (古い順のまま、最新の枠まで) */
  rows: LiveToolRow[];
  /** 枠から溢れて「…他 N 件」に畳んだ行数 */
  hidden: number;
  phase: LiveToolPhase;
};

/**
 * 入力欄の直上に浮かせるライブ表示の状態。枠・ホールド・畳みの規則は lib/liveToolCall.ts の純関数が正で、
 * ここはタイマーで時を進めるだけにする。箱を浮かせる分の余白はチャット側が要るため、両方を持つ App が呼ぶ。
 */
export function useLiveToolCall({
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
}): LiveToolCallView {
  const state = useMemo(() => liveToolState(runTools, runStatus), [runTools, runStatus]);
  const liveIds = useMemo(() => new Set(liveToolIds), [liveToolIds]);
  // 箱に出し続ける行 (実行中として出せなかった分と、終わってホールド中の分)
  const [held, setHeld] = useState<LiveToolHold[]>([]);
  // 畳みはじめの合図。行は畳みの間も残す (外すのは LIVE_CLOSE_MS 後)
  const [closing, setClosing] = useState(false);
  const trackerRef = useRef<{ key: string | undefined; tracker: LiveToolTracker } | null>(null);

  // 実行中として出せなかった行 (一瞬のツール / run の終了と同時に届いた分) をホールドへ移す
  useEffect(() => {
    const at = Date.now();
    const known = trackerRef.current;
    // セッションが変わると runTools ごと入れ替わる。前のセッションの行を畳む対象に持ち越さない
    const switched = known === null || known.key !== sessionId;
    const tracker = known !== null && !switched ? known.tracker : initialLiveTracker(runTools);
    const next = trackLiveHolds(tracker, { rows: state.rows, allRows: state.allRows, liveIds, now: at });
    trackerRef.current = { key: sessionId, tracker: next.tracker };
    // 新しいツールが動き出したら、あるいは畳みはじめに新しい行が現れたら畳みをやめる。後者を state.visible
    // だけで見ると、開始と終了が同じ描画にまとまった行 (実行中として一度も出ない) を 900ms のホールドごと
    // 畳んでしまう (タイマーの後始末は畳みの effect が持つ)
    if (state.visible || next.holds.length > 0) setClosing(false);
    if (switched) {
      setHeld([]);
      setClosing(false);
      return;
    }
    if (next.holds.length === 0) return;
    setHeld((list) => [
      // 同じ id がもう一度現れたときは、古いホールドを残さない
      ...list.filter((item) => !next.holds.some((hold) => hold.row.id === item.row.id)),
      ...next.holds,
    ]);
  }, [state, liveIds, sessionId, runTools]);

  // ホールドが切れたら行を外す。実行中の行が無く、残りも全部切れていたら畳みはじめる。行ごとにタイマーを
  // 張るのは、一番早い行が切れた後も次の行のタイマーを引き直さずに済ませるため
  useEffect(() => {
    if (held.length === 0 || closing) return;
    const timers = held.map((hold) =>
      window.setTimeout(
        () => {
          const at = Date.now();
          if (state.rows.length > 0) {
            setHeld((list) => list.filter((item) => liveToolHoldRemainingMs(item, at) > 0));
            return;
          }
          if (liveToolPhase(state.rows, held, at) === "closing") setClosing(true);
        },
        Math.max(0, hold.holdUntilMs - Date.now()),
      ),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [closing, held, state.rows]);

  // 畳みは 1 段。行・箱・余白を同じ時間で畳んでから行を外す
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setHeld([]);
      setClosing(false);
    }, LIVE_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  const phase: LiveToolPhase = closing ? "closing" : state.rows.length > 0 || held.length > 0 ? "open" : "hidden";
  const windowed = useMemo(
    () =>
      liveToolWindow(
        state.rows,
        held.map((hold) => hold.row),
      ),
    [state.rows, held],
  );
  return { rows: windowed.rows, hidden: windowed.hidden, phase };
}
