/**
 * 全スペース横断の実行状況 ( `/activity` ) の導出。会話 1 件 = 1 行とし、進行中 (回答待ち / 処理中) と
 * 直近 120 分の終了を 1 画面に出す。区分は排他 (圧縮中 → 回答待ち → 実行中 → 終了) で、件数・並び・
 * 経過時間の文字列はすべてこの module を正とする (docs/frontend.md)。
 */
import type { Project, ServeCommand, SessionSummary } from "../types";
import { messageTimeLabel } from "./messageTime";
import { DEFAULT_SPACE_ID } from "./spaceSelection";

/** 終了行を残す長さ。BFF の sweep も同じ長さだけ終了済みのレコードを残す */
export const ACTIVITY_FINISHED_WINDOW_MS = 120 * 60 * 1000;

/** 表示区分。回答待ちを先頭に、処理中 (実行中 + 圧縮中)、直近の終了の順に並べる */
export type ActivityKind = "waiting" | "working" | "finished";

export const ACTIVITY_GROUP_ORDER: readonly ActivityKind[] = ["waiting", "working", "finished"];

export type ActivityRow = {
  sessionId: string;
  spaceId: string;
  title: string;
  agentName: string;
  /** 所属プロジェクト名。未所属・取得前・削除済みは「未所属」 */
  projectLabel: string;
  kind: ActivityKind;
  status: SessionSummary["status"];
  /** 経過時間の起点。queued と時刻欠落では undefined (数字を出さない) */
  since?: number;
  /** 終了行の終了時刻 */
  finishedAt?: number;
  /** 終了行の所要時間 (runOutcomes にあるときだけ) */
  durationMs?: number;
  /** その会話の作業ディレクトリの serve 成功実績。無ければ null (起動の操作を出す条件) */
  serveCommand: ServeCommand | null;
  /** 並びの基準 (処理中 / 回答待ちは lastUsedAt、終了は finishedAt) */
  sortAt: number;
};

export type ActivityCounts = {
  /** 進行中の会話数。回答待ち + 処理中 (圧縮中を二重に数えない) */
  inProgress: number;
  waiting: number;
  working: number;
  running: number;
  compacting: number;
  finished: number;
};

const FINISHED_STATUSES: ReadonlySet<SessionSummary["status"]> = new Set(["completed", "stopped", "error"]);

/** 進行中 (回答待ち / 実行中 / 圧縮中) か。件数だけを出す入口もこの判定を使う */
export function isActivityProgress(summary: Pick<SessionSummary, "status" | "awaitingAnswer">): boolean {
  return (
    summary.status === "compacting" ||
    summary.awaitingAnswer === true ||
    summary.status === "running" ||
    summary.status === "queued"
  );
}

/** 進行中の会話数 (サイドバーの入口)。終了は含めないので時刻に依存しない */
export function activityProgressCount(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((count, summary) => (isActivityProgress(summary) ? count + 1 : count), 0);
}

/**
 * 一覧から実行状況の行を作る。区分は排他で、圧縮中を最優先、次に回答待ち、次に実行中 (`queued` を含む)。
 * 終了は `finishedAt` から 120 分以内だけを残し、`idle` とそれより古い終了は出さない。
 * 並びは 回答待ち → 処理中 → 直近の終了。処理中と回答待ちは `lastUsedAt` の新しい順、終了は
 * `finishedAt` の新しい順で、同値は `sessionId` で安定させる。
 */
export function activityRows(
  sessions: readonly SessionSummary[],
  projects: readonly Project[],
  now: number,
): ActivityRow[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const rows: ActivityRow[] = [];
  for (const summary of sessions) {
    const base = {
      sessionId: summary.sessionId,
      spaceId: summary.spaceId ?? DEFAULT_SPACE_ID,
      title: summary.title,
      agentName: summary.agentName || "エージェント名不明",
      projectLabel: (summary.projectId ? projectNames.get(summary.projectId) : undefined) ?? "未所属",
      status: summary.status,
      serveCommand: summary.serveCommand,
      sortAt: summary.lastUsedAt,
    };
    if (summary.status === "compacting") {
      rows.push({ ...base, kind: "working", since: summary.compactionStartedAt });
      continue;
    }
    if (summary.awaitingAnswer === true) {
      rows.push({ ...base, kind: "waiting", since: summary.awaitingSince });
      continue;
    }
    if (summary.status === "running" || summary.status === "queued") {
      // queued はラン開始前なので開始時刻を出さない (lastUsedAt は開く・回答でも動くため代用しない)
      rows.push({ ...base, kind: "working", since: summary.status === "running" ? summary.runStartedAt : undefined });
      continue;
    }
    if (!FINISHED_STATUSES.has(summary.status)) continue;
    const finishedAt = summary.finishedAt;
    if (finishedAt === undefined || now - finishedAt > ACTIVITY_FINISHED_WINDOW_MS) continue;
    rows.push({ ...base, kind: "finished", finishedAt, durationMs: summary.lastRunDurationMs, sortAt: finishedAt });
  }
  return rows.sort(compareActivityRows);
}

function compareActivityRows(a: ActivityRow, b: ActivityRow): number {
  const group = ACTIVITY_GROUP_ORDER.indexOf(a.kind) - ACTIVITY_GROUP_ORDER.indexOf(b.kind);
  if (group !== 0) return group;
  if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** 同じ行から数える (回答待ちと圧縮中を合計へ二重計上しない) */
export function activityCounts(rows: readonly ActivityRow[]): ActivityCounts {
  const counts: ActivityCounts = { inProgress: 0, waiting: 0, working: 0, running: 0, compacting: 0, finished: 0 };
  for (const row of rows) {
    if (row.kind === "finished") {
      counts.finished += 1;
      continue;
    }
    counts.inProgress += 1;
    if (row.kind === "waiting") {
      counts.waiting += 1;
      continue;
    }
    counts.working += 1;
    if (row.status === "compacting") counts.compacting += 1;
    else counts.running += 1;
  }
  return counts;
}

export function activityGroupLabel(kind: ActivityKind): string {
  switch (kind) {
    case "waiting":
      return "回答待ち";
    case "working":
      return "処理中";
    case "finished":
      return "直近に終了";
  }
}

export function activityStatusLabel(row: ActivityRow): string {
  if (row.kind === "waiting") return "回答待ち";
  if (row.kind === "working") return row.status === "compacting" ? "圧縮中" : "実行中";
  switch (row.status) {
    case "stopped":
      return "停止";
    case "error":
      return "失敗";
    default:
      return "完了";
  }
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * 経過時間。`mm:ss`、1 時間以上は `h:mm:ss` (locale 非依存)。毎秒更新するので秒未満は切り捨てる。
 * 回答待ちは「待ち」を付ける (数字だけだと何の時間か読めない)。
 */
export function activityElapsedLabel(row: ActivityRow, now: number): string | undefined {
  if (row.kind === "finished" || row.since === undefined) return undefined;
  const elapsed = formatActivityClock(now - row.since);
  return row.kind === "waiting" ? `${elapsed} 待ち` : elapsed;
}

export function formatActivityClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/** 終了行の表示。所要時間が無ければ終了時刻だけにする (旧サーバー・再起動後) */
export function activityFinishedLabel(
  row: ActivityRow,
  now: number,
  options: { timeZone?: string } = {},
): string | undefined {
  if (row.kind !== "finished" || row.finishedAt === undefined) return undefined;
  const time = messageTimeLabel(row.finishedAt, { now, timeZone: options.timeZone });
  return row.durationMs === undefined
    ? `${time} 終了`
    : `${time} 終了 · 所要 ${formatActivityDuration(row.durationMs)}`;
}

/** 所要時間の読み上げ用の表記 (18分24秒 / 1時間2分)。秒は所要が 1 分未満のときだけ出す */
export function formatActivityDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
  if (minutes > 0) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
  return `${seconds}秒`;
}
