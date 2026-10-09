/**
 * 入力欄の直上に浮かせるライブのツール行。行は走査順で、番号はツール履歴の行番号に合わせる
 * (スキル読み込み・ask_user を外す規則も履歴と同じ)。表示条件と畳み方の規則の根拠は docs/frontend.md が正。
 */
import type { RunStatus, ToolCall } from "../types";
import { abbreviatedToolSummary } from "./toolSummary";
import { toolDurationMs } from "./toolTiming";

/**
 * 行を出してから畳み始めるまでの最短時間。一瞬で終わるツールでも「何が走ったか」を読めるようにする。
 * 出現は遅らせない (詰まらせない側のつまみ)。
 */
export const LIVE_ROW_MIN_VISIBLE_MS = 900;

/** 箱に出す行数。溢れた行は古い順に落とし、件数だけを「…他 N 件」の 1 行に畳む (キューは持たない) */
export const LIVE_ROW_SLOTS = 3;

/**
 * 行を箱から外すまで。行・箱・余白を同じ時間で畳むので、CSS の畳みと同じ値でなければならない。
 */
export const LIVE_CLOSE_MS = 180;

/**
 * ライブ行に出す子の本文の行数。行の下の左罫線が行の要約との区切りになり、箱の高さは
 * styles/index.css の `.chat-live-reserve` が同じ行数から見積もる (ライブでは 1 行)。
 */
export const LIVE_PROGRESS_BODY_LINES = 1;
export const LIVE_PROGRESS_BODY_MAX = 200;

export type LiveToolProgress = {
  /** 直近の子ツール実行の 1 行要約 */
  activity: string;
  /** 生成中の子の本文末尾 (上限まで) */
  body: string;
};

export type LiveToolRow = {
  id: string;
  /** ツール履歴に並ぶ通し番号 (スキル読み込み・ask_user を除いた並び) */
  index: number;
  /** `name — args` の 1 行。切り方は履歴の行サマリーと同じ */
  summary: string;
  done: boolean;
  /** 終了済みの行だけ入る (BFF 計測)。開始 / 終了が揃わない行は undefined */
  durationMs?: number;
  /** investigate の進捗 (ライブの `tool_progress` だけが入れる。履歴には残らない) */
  progress?: LiveToolProgress;
};

export type LiveToolState = {
  /** 実行中の行 (箱に出す) */
  rows: LiveToolRow[];
  /** 実行中かどうかに関わらず、直近 run の全行 (畳む判定と、出す前に終わった行の本文に使う) */
  allRows: LiveToolRow[];
  visible: boolean;
};

/**
 * `tool_progress` の本文をライブ行の 2 段 (現在の活動 / 子の本文末尾) へ分ける。runner は両者を 1 本の
 * 本文へ詰めて流すため、先頭行を活動、残りを本文として読む。本文は末尾だけを上限まで残す。
 */
export function liveToolProgress(text: string): LiveToolProgress {
  const [first = "", ...rest] = text.split("\n");
  const lines = rest.filter((line) => line.trim() !== "");
  const tail = lines.slice(-LIVE_PROGRESS_BODY_LINES).join("\n");
  const body = tail.length > LIVE_PROGRESS_BODY_MAX ? `…${tail.slice(tail.length - LIVE_PROGRESS_BODY_MAX)}` : tail;
  return { activity: first.trim(), body };
}

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
        ...(call.progress === undefined ? {} : { progress: liveToolProgress(call.progress) }),
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
};

/** mount 時点の呼び出しは「観測済み」にする。復元直後に前の run の完了カードを光らせない */
export function initialLiveTracker(runTools: Readonly<Record<string, ToolCall>>): LiveToolTracker {
  return { shownAt: new Map(), accounted: new Set(Object.keys(runTools)), running: new Map() };
}

/** 実行中として出せなかった行を、いつまで箱に残すか (絶対時刻) */
export type LiveToolHold = { row: LiveToolRow; holdUntilMs: number };

/** 行を畳むまでに残っているホールド (ミリ秒)。0 なら畳んでよい */
export function liveToolHoldRemainingMs(hold: LiveToolHold, now: number): number {
  return Math.max(0, hold.holdUntilMs - now);
}

/**
 * どの行を畳む前にもう少し出しておくかを決める。次の 2 経路を同じ規則で扱う。
 *
 * 1. ライブのツールイベントで新しく現れたのに、実行中の行として出ていない呼び出しは、最短表示時間の
 *    ぶんここで出す (開始と終了が同じ描画にまとまった一瞬のツール、run の終了と同時に届いた分)。
 *    ライブで観測した id (`liveIds`) を条件にするのは、runTools の形だけではライブの出来事と
 *    `resync` が持ち込んだ復元カードを区別できないため。同じ描画に両方が混ざっても、復元カードは
 *    出さない。
 * 2. 実行中として出ていた行が終わった / run ごと消えた場合は、出ていた時間の残りだけ残す
 *    (長く動いていたツールはその場で畳む)。
 */
export function trackLiveHolds(
  tracker: LiveToolTracker,
  {
    rows,
    allRows,
    liveIds,
    now,
  }: { rows: LiveToolRow[]; allRows: LiveToolRow[]; liveIds: ReadonlySet<string>; now: number },
): { tracker: LiveToolTracker; holds: LiveToolHold[] } {
  const shownAt = new Map(tracker.shownAt);
  const accounted = new Set(tracker.accounted);
  const runningIds = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (!shownAt.has(row.id)) shownAt.set(row.id, now);
  }

  const byId = new Map(allRows.map((row) => [row.id, row]));
  const holds: LiveToolHold[] = [];
  for (const row of allRows) {
    // 実行中として出る行は、そのまま出せばよいので保持しない
    if (accounted.has(row.id) || runningIds.has(row.id) || !liveIds.has(row.id)) continue;
    accounted.add(row.id);
    holds.push({ row, holdUntilMs: now + LIVE_ROW_MIN_VISIBLE_MS });
  }
  for (const [id, row] of tracker.running) {
    if (runningIds.has(id)) continue;
    const shown = shownAt.get(id);
    shownAt.delete(id);
    // 出ていた時間の残りだけを残す (長く出ていた行は 0 = その場で畳む)
    holds.push({ row: byId.get(id) ?? row, holdUntilMs: (shown ?? now) + LIVE_ROW_MIN_VISIBLE_MS });
  }
  // 観測した id はライブかどうかに関係なく記録する。次の描画で過去のカードを光らせない
  for (const row of allRows) accounted.add(row.id);
  return { tracker: { shownAt, accounted, running: new Map(rows.map((row) => [row.id, row])) }, holds };
}

/** 箱の段。`hidden` は箱ごと消えている (浮かせる前の余白も確保しない) */
export type LiveToolPhase = "hidden" | "open" | "closing";

/**
 * 箱の段を決める。実行中の行があれば開き、無ければ残っている行をホールドの切れるまで見せる。
 * 閉じは 1 段にまとめる (行・箱・余白を同じ時間で畳む) ため、ホールドが全部切れた時点で `closing` にし、
 * 行は畳みの間だけ残す (実際に外すのは LIVE_CLOSE_MS 後)。
 */
export function liveToolPhase(
  running: readonly LiveToolRow[],
  held: readonly LiveToolHold[],
  now: number,
): LiveToolPhase {
  if (running.length > 0) return "open";
  if (held.length === 0) return "hidden";
  return held.every((hold) => liveToolHoldRemainingMs(hold, now) <= 0) ? "closing" : "open";
}

export type LiveToolWindow = {
  /** 箱に出す行 (古い順のまま、最新の枠まで) */
  rows: LiveToolRow[];
  /** 枠から溢れて「…他 N 件」に畳んだ行数 */
  hidden: number;
};

/**
 * 箱に出す行を最新の枠まで切り、溢れた件数を返す。実行中の行とホールド中の行は同じ箱に並ぶため、
 * id で重複を落として (実行中を優先) 走査順に並べ、古い行から枠を落とす。
 */
export function liveToolWindow(running: readonly LiveToolRow[], held: readonly LiveToolRow[]): LiveToolWindow {
  const byId = new Map(held.map((row) => [row.id, row]));
  for (const row of running) byId.set(row.id, row);
  const ordered = [...byId.values()].sort((a, b) => a.index - b.index);
  return { rows: ordered.slice(-LIVE_ROW_SLOTS), hidden: Math.max(0, ordered.length - LIVE_ROW_SLOTS) };
}
