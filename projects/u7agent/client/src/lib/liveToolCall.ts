/**
 * 入力欄の上の状態行に出す、直近 run のツール行。番号はツール履歴の行番号に合わせる
 * (スキル読み込み・ask_user を外す規則も履歴と同じ)。表示条件と文言の規則の根拠は docs/frontend.md が正。
 */
import type { RunStatus, ToolCall } from "../types";
import { abbreviatedToolSummary, toolSummary } from "./toolSummary";
import { toolDurationMs } from "./toolTiming";

/**
 * 状態行のツール文言を更新する間隔。start / end が速いときに文言が連打されないよう、
 * 表示側はこの間隔で最新の状態だけを描く。
 */
export const LIVE_TOOL_TEXT_THROTTLE_MS = 120;

/**
 * 状態行の title に載せる進捗本文の行数。状態行は 1 行に保ち、本文は hover で読む。
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
  /** ツール名 (investigate の進捗を `name — activity` で出すのに使う) */
  name: string;
  /** ツール履歴に並ぶ通し番号 (スキル読み込み・ask_user を除いた並び) */
  index: number;
  /** `name — args` の 1 行。切り方は履歴の行サマリーと同じ */
  summary: string;
  /** 省略前の `name — args`。状態行の title 用 */
  fullSummary: string;
  done: boolean;
  /** 終了済みの行だけ入る (BFF 計測)。開始 / 終了が揃わない行は undefined */
  durationMs?: number;
  /** investigate の進捗 (ライブの `tool_progress` だけが入れる。履歴には残らない) */
  progress?: LiveToolProgress;
};

/**
 * `tool_progress` の本文を状態行の活動と title 用の本文末尾へ分ける。runner は両者を 1 本の
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
        name: call.name,
        index: index + 1,
        summary: abbreviatedToolSummary(call),
        fullSummary: toolSummary(call),
        done: call.done,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(call.progress === undefined ? {} : { progress: liveToolProgress(call.progress) }),
      };
    });
}

export type LiveToolStatus = {
  /** 実行中の行 (走査順) */
  running: LiveToolRow[];
  /** 状態行に出す最新の実行中行 (走査順の末尾) */
  latest?: LiveToolRow;
  /** 表示対象の全行数 (完了分を含む) */
  totalCount: number;
};

/**
 * 状態行に出す実行中の行を選ぶ。run が実行中でなければ出さない (停止・中断で `tool_end` が
 * 来なかったカードを回し続けない)。run が続いていてもツールが動いていない間は空にし、
 * サーバーの活動文言 (考え中 / 応答を書いています) へ戻す。
 */
export function liveToolStatus(runTools: Readonly<Record<string, ToolCall>>, runStatus: RunStatus): LiveToolStatus {
  const allRows = liveToolRows(runTools);
  const running = runStatus === "running" ? allRows.filter((row) => !row.done) : [];
  return { running, latest: running[running.length - 1], totalCount: allRows.length };
}

export type LiveToolStatusView = {
  /** 状態行の 1 行に出す文言 */
  text: string;
  /** hover で読む全文 (省略前のサマリーと進捗の本文末尾) */
  title: string;
  /** 最新の実行中ツールの id。短命ツールを出さない判定に使う */
  latestId: string;
};

/**
 * 状態行の文言。並列実行では件数を先頭に足し、investigate では `summary` より現在の
 * 子の活動を優先する。本文末尾は 1 行を保つため `title` にだけ残す。
 */
export function liveToolStatusView(status: LiveToolStatus): LiveToolStatusView | undefined {
  const latest = status.latest;
  if (latest === undefined) return undefined;

  const progress = latest.progress;
  const activity = progress?.activity.trim() ?? "";
  const current = activity ? (latest.name ? `${latest.name} — ${activity}` : activity) : latest.summary;
  const prefix = status.running.length > 1 ? `${status.running.length}件実行中 · ` : "実行中 · ";
  const title = [latest.fullSummary, progress?.activity, progress?.body, "実行中のツール"]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join("\n");
  return { text: `${prefix}${current}`, title, latestId: latest.id };
}

/** 表示の同一性。latestId を混ぜ、同じ文言の別ツールを同じ表示として扱わない */
export function liveToolViewKey(view: LiveToolStatusView | undefined): string {
  return view === undefined ? "" : `${view.latestId}\u0000${view.text}\u0000${view.title}`;
}

export type LiveToolDisplayPlan =
  | { type: "clear" }
  | { type: "hold"; id: string; delayMs: number }
  | { type: "show" }
  | { type: "wait"; delayMs: number }
  | { type: "noop" };

/**
 * 状態行の次の表示を決める。新規ツールは前回の表示時刻ではなく、その id を観測してから
 * 同じ間隔だけ待つ。短命な並列ツールを、直前の表示から時間が経っていても出さないため。
 * 同じツールの進捗だけを既存の間隔で間引く (docs/frontend.md)。
 */
export function liveToolDisplayPlan(input: {
  view: LiveToolStatusView | undefined;
  display: LiveToolStatusView | undefined;
  lastShownAt: number;
  pendingNewId: string | undefined;
  now: number;
}): LiveToolDisplayPlan {
  const { view, display, lastShownAt, pendingNewId, now } = input;
  if (view === undefined) return { type: "clear" };
  if (view.latestId !== display?.latestId) {
    if (pendingNewId === view.latestId) return { type: "noop" };
    return { type: "hold", id: view.latestId, delayMs: LIVE_TOOL_TEXT_THROTTLE_MS };
  }
  if (liveToolViewKey(view) === liveToolViewKey(display)) return { type: "noop" };
  const wait =
    lastShownAt === 0 ? LIVE_TOOL_TEXT_THROTTLE_MS : Math.max(0, LIVE_TOOL_TEXT_THROTTLE_MS - (now - lastShownAt));
  return wait === 0 ? { type: "show" } : { type: "wait", delayMs: wait };
}
