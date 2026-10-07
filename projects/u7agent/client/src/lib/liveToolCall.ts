/**
 * 入力欄の直上に出すライブのツール行。行は走査順で、番号はツール履歴の行番号に合わせる
 * (スキル読み込み・ask_user を外す規則も履歴と同じ)。表示条件と畳み方の規則の根拠は docs/frontend.md が正。
 */
import type { RunStatus, ToolCall } from "../types";
import { abbreviatedToolSummary } from "./toolSummary";
import { toolDurationMs } from "./toolTiming";

/**
 * 行を出してから畳み始めるまでの最短時間。一瞬で終わるツールでも「何が走ったか」を読めるようにする。
 */
export const LIVE_ROW_MIN_VISIBLE_MS = 900;

export type LiveToolRow = {
  id: string;
  /** ツール履歴に並ぶ通し番号 (スキル読み込み・ask_user を除いた並び) */
  index: number;
  /** `name — args` の 1 行。切り方は履歴の行サマリーと同じ */
  summary: string;
  done: boolean;
  /** 終了済みの行だけ入る (BFF 計測)。開始 / 終了が揃わない行は undefined */
  durationMs?: number;
};

export type LiveToolState = {
  /** 実行中の行 (箱に出す) */
  rows: LiveToolRow[];
  /** 実行中かどうかに関わらず、直近 run の全行 (畳む判定と、出す前に終わった行の本文に使う) */
  allRows: LiveToolRow[];
  visible: boolean;
};

/** 直近 run のツール行。`done` はフィルタせず、表示側が実行中だけを選ぶ */
export function liveToolRows(runTools: Readonly<Record<string, ToolCall>>): LiveToolRow[] {
  return Object.values(runTools)
    .filter((call) => !call.skill && !call.questions?.length)
    .map((call, index) => {
      // 実行時間は終了イベントを受けたカードだけが持つ (BFF 計測。docs/api-sessions.md)
      const durationMs = toolDurationMs(call);
      return {
        id: call.id,
        index: index + 1,
        summary: abbreviatedToolSummary(call),
        done: call.done,
        ...(durationMs === undefined ? {} : { durationMs }),
      };
    });
}

/**
 * ライブ表示は「いま動いているツール」だけを出す。run が続いていてもツールが動いていない間は
 * 状態行の文言で足りるため、空の箱を残さない。`queued` は run が動いていない状態なので含めない。
 * 停止・中断で `tool_execution_end` が来なかったカードを回し続けないためでもある (docs/frontend.md)。
 */
export function liveToolState(runTools: Readonly<Record<string, ToolCall>>, runStatus: RunStatus): LiveToolState {
  const allRows = liveToolRows(runTools);
  if (runStatus !== "running") return { rows: [], allRows, visible: false };
  const rows = allRows.filter((row) => !row.done);
  return { rows, allRows, visible: rows.length > 0 };
}

/** 終わった行を最短表示時間まで残すための状態。コンポーネントは ref で持ち、描画のたびに進める */
export type LiveToolTracker = {
  /** 実行中の行として出した時刻。残りの最短表示時間を出す */
  shownAt: Map<string, number>;
  /** 畳む判定を済ませた id (mount 時にあった分は最初から入れる) */
  accounted: Set<string>;
  /** 直前の描画で実行中だった行。run ごと消えた行も畳めるようにする */
  running: Map<string, LiveToolRow>;
  /** 最後に観測した `tool_start` / `tool_end` の回数 (ChatState.toolEventSeq)。復元カードと区別する */
  eventSeq: number;
};

/** mount 時点の呼び出しは「観測済み」にする。復元直後に前の run の完了カードを光らせない */
export function initialLiveTracker(runTools: Readonly<Record<string, ToolCall>>, eventSeq: number): LiveToolTracker {
  return { shownAt: new Map(), accounted: new Set(Object.keys(runTools)), running: new Map(), eventSeq };
}

export type LiveToolHold = { row: LiveToolRow; holdMs: number };

/**
 * どの行を畳む前にもう少し出しておくかを決める。次の 2 経路を同じ規則で扱う。
 *
 * 1. ライブのツールイベントで新しく現れたのに、実行中の行として出ていない呼び出しは、最短表示時間の
 *    ぶんここで出す (開始と終了が同じ描画にまとまった一瞬のツール、run の終了と同時に届いた分)。
 *    条件に `eventSeq` を使うのは、runTools の形だけではライブの出来事と `resync` が持ち込んだ復元
 *    カードを区別できないため (後者を光らせない)。
 * 2. 実行中として出ていた行が終わった / run ごと消えた場合は、出ていた時間の残りだけ残す
 *    (長く動いていたツールはその場で畳む)。
 */
export function trackLiveHolds(
  tracker: LiveToolTracker,
  { rows, allRows, eventSeq, now }: { rows: LiveToolRow[]; allRows: LiveToolRow[]; eventSeq: number; now: number },
): { tracker: LiveToolTracker; holds: LiveToolHold[] } {
  const shownAt = new Map(tracker.shownAt);
  const accounted = new Set(tracker.accounted);
  const runningIds = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (!shownAt.has(row.id)) shownAt.set(row.id, now);
  }

  const byId = new Map(allRows.map((row) => [row.id, row]));
  const holds: LiveToolHold[] = [];
  if (eventSeq !== tracker.eventSeq) {
    for (const row of allRows) {
      // 実行中として出る行は、そのまま出せばよいので保持しない
      if (accounted.has(row.id) || runningIds.has(row.id)) continue;
      accounted.add(row.id);
      holds.push({ row, holdMs: LIVE_ROW_MIN_VISIBLE_MS });
    }
  }
  for (const [id, row] of tracker.running) {
    if (runningIds.has(id)) continue;
    const shown = shownAt.get(id);
    shownAt.delete(id);
    holds.push({
      row: byId.get(id) ?? row,
      holdMs: Math.max(0, LIVE_ROW_MIN_VISIBLE_MS - (now - (shown ?? now))),
    });
  }
  // 観測した id はライブかどうかに関係なく記録する。次の描画で過去のカードを光らせない
  for (const row of allRows) accounted.add(row.id);
  return {
    tracker: { shownAt, accounted, running: new Map(rows.map((row) => [row.id, row])), eventSeq },
    holds,
  };
}
