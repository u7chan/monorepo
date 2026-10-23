// 実行状況 (全スペース横断) の導出。区分の排他・並び・件数・経過時間の文字列・終了の表示を純関数で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_FINISHED_WINDOW_MS,
  activityCounts,
  activityElapsedLabel,
  activityFinishedLabel,
  activityProgressCount,
  activityRows,
  activityStatusLabel,
  formatActivityClock,
  formatActivityDuration,
} from "../src/lib/activity";
import type { Project, SessionSummary } from "../src/types";

const NOW = Date.UTC(2026, 9, 23, 5, 32, 8);

/** 一覧の 1 件。既定は idle (表示対象外) で、テストごとに対象の状態だけを足す */
function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    spaceId: "default",
    title: "会話",
    agentId: "agent-1",
    agentName: "開発アシスタント",
    status: "idle",
    queueDepth: 0,
    pinned: false,
    messageCount: 1,
    createdAt: NOW - 600_000,
    lastUsedAt: NOW - 60_000,
    ...overrides,
  };
}

const ids = (rows: ReturnType<typeof activityRows>): string[] => rows.map((row) => row.sessionId);

test("区分は排他で、圧縮中 → 回答待ち → 実行中 (queued を含む) → 直近の終了の順に決まる", () => {
  const rows = activityRows(
    [
      // 圧縮中は回答待ちより先に見る (同時には起きないが、排他の優先順位を固定する)
      summary({ sessionId: "compact", status: "compacting", awaitingAnswer: true, compactionStartedAt: NOW - 1_000 }),
      summary({ sessionId: "wait", status: "running", awaitingAnswer: true, awaitingSince: NOW - 5_000 }),
      summary({ sessionId: "run", status: "running", runStartedAt: NOW - 3_000 }),
      summary({ sessionId: "queue", status: "queued" }),
      summary({ sessionId: "done", status: "completed", finishedAt: NOW - 10_000, lastRunDurationMs: 5_000 }),
      summary({ sessionId: "stopped", status: "stopped", finishedAt: NOW - 20_000 }),
      summary({ sessionId: "error", status: "error", finishedAt: NOW - 30_000 }),
      // 対象外: idle / 終了時刻の無い終了
      summary({ sessionId: "idle", status: "idle" }),
      summary({ sessionId: "unknown-finish", status: "completed" }),
    ],
    [],
    NOW,
  );
  const kindOf = new Map(rows.map((row) => [row.sessionId, row.kind]));
  assert.equal(kindOf.get("compact"), "working");
  assert.equal(kindOf.get("wait"), "waiting");
  assert.equal(kindOf.get("run"), "working");
  assert.equal(kindOf.get("queue"), "working");
  assert.equal(kindOf.get("done"), "finished");
  assert.equal(kindOf.get("stopped"), "finished");
  assert.equal(kindOf.get("error"), "finished");
  assert.equal(kindOf.has("idle"), false);
  assert.equal(kindOf.has("unknown-finish"), false);
});

test("終了は 120 分の境界まで表示し、超えたら外す", () => {
  const at = (finishedAt: number) => activityRows([summary({ status: "completed", finishedAt })], [], NOW).length;
  assert.equal(at(NOW - ACTIVITY_FINISHED_WINDOW_MS), 1, "ちょうど 120 分は残す");
  assert.equal(at(NOW - ACTIVITY_FINISHED_WINDOW_MS - 1), 0, "120 分を超えたら外す");
  assert.equal(at(NOW + 1_000), 1, "時計のずれで未来になっても落とさない");
});

test("回答待ちを先頭にし、処理中は lastUsedAt・終了は finishedAt の新しい順、同値は sessionId", () => {
  const rows = activityRows(
    [
      summary({ sessionId: "done-old", status: "completed", finishedAt: NOW - 30_000 }),
      summary({ sessionId: "run-old", status: "running", lastUsedAt: NOW - 90_000 }),
      summary({ sessionId: "wait", status: "running", awaitingAnswer: true, awaitingSince: NOW - 1_000 }),
      summary({ sessionId: "done-new", status: "completed", finishedAt: NOW - 10_000 }),
      summary({ sessionId: "run-new", status: "running", lastUsedAt: NOW - 10_000 }),
      summary({ sessionId: "run-new-b", status: "running", lastUsedAt: NOW - 10_000 }),
    ],
    [],
    NOW,
  );
  assert.deepEqual(ids(rows), ["wait", "run-new", "run-new-b", "run-old", "done-new", "done-old"]);
});

test("同じエージェントの並列実行も会話ごとに 1 行とし、件数は二重計上しない", () => {
  const rows = activityRows(
    [
      summary({ sessionId: "a", agentId: "agent-1", status: "running" }),
      summary({ sessionId: "b", agentId: "agent-1", status: "running" }),
      summary({ sessionId: "c", status: "compacting", compactionStartedAt: NOW - 1_000 }),
      summary({ sessionId: "d", status: "running", awaitingAnswer: true, awaitingSince: NOW - 1_000 }),
      summary({ sessionId: "e", status: "completed", finishedAt: NOW - 1_000 }),
    ],
    [],
    NOW,
  );
  assert.equal(rows.length, 5, "同じエージェントでも 2 会話は 2 行");
  assert.deepEqual(activityCounts(rows), {
    inProgress: 4,
    waiting: 1,
    working: 3,
    running: 2,
    compacting: 1,
    finished: 1,
  });
});

test("入口の件数は全スペースの進行中だけを数え、終了と idle を含めない", () => {
  const sessions = [
    summary({ sessionId: "a", spaceId: "default", status: "running" }),
    summary({ sessionId: "b", spaceId: "space-1", status: "queued" }),
    summary({ sessionId: "c", spaceId: "space-2", status: "compacting" }),
    summary({ sessionId: "d", spaceId: "space-2", awaitingAnswer: true }),
    summary({ sessionId: "e", status: "completed", finishedAt: NOW - 1_000 }),
    summary({ sessionId: "f", status: "idle" }),
  ];
  assert.equal(activityProgressCount(sessions), 4);
});

test("経過時間は mm:ss / h:mm:ss で、回答待ちには「待ち」を付け、queued と時刻欠落では出さない", () => {
  assert.equal(formatActivityClock(0), "00:00");
  assert.equal(formatActivityClock(252_400), "04:12");
  assert.equal(formatActivityClock(59 * 60_000 + 59_000), "59:59");
  assert.equal(formatActivityClock(3_600_000), "1:00:00");
  assert.equal(formatActivityClock(3_852_000), "1:04:12");
  assert.equal(formatActivityClock(-1_000), "00:00");

  const [waiting] = activityRows(
    [summary({ status: "running", awaitingAnswer: true, awaitingSince: NOW - 252_000 })],
    [],
    NOW,
  );
  assert.equal(activityElapsedLabel(waiting, NOW), "04:12 待ち");

  const [compacting] = activityRows([summary({ status: "compacting", compactionStartedAt: NOW - 110_000 })], [], NOW);
  assert.equal(activityElapsedLabel(compacting, NOW), "01:50");

  const [running] = activityRows([summary({ status: "running", runStartedAt: NOW - 758_000 })], [], NOW);
  assert.equal(activityElapsedLabel(running, NOW), "12:38");

  // queued はラン開始前なので出さない。lastUsedAt を開始時刻に使わない
  const [queued] = activityRows([summary({ status: "queued", lastUsedAt: NOW - 60_000 })], [], NOW);
  assert.equal(activityElapsedLabel(queued, NOW), undefined);
  // 旧サーバー・時刻欠落
  const [missing] = activityRows([summary({ status: "running" })], [], NOW);
  assert.equal(activityElapsedLabel(missing, NOW), undefined);
});

test("終了行は終了時刻と、所要時間があるときだけ「所要」を出す", () => {
  const [withDuration] = activityRows(
    [summary({ status: "completed", finishedAt: NOW - 60_000, lastRunDurationMs: 18 * 60_000 + 24_000 })],
    [],
    NOW,
  );
  assert.equal(activityFinishedLabel(withDuration, NOW, { timeZone: "UTC" }), "05:31 終了 · 所要 18分24秒");
  const [withoutDuration] = activityRows([summary({ status: "stopped", finishedAt: NOW - 60_000 })], [], NOW);
  assert.equal(activityFinishedLabel(withoutDuration, NOW, { timeZone: "UTC" }), "05:31 終了");
  assert.equal(activityElapsedLabel(withDuration, NOW), undefined, "終了行に毎秒の数字は出さない");
});

test("所要時間は 1 分未満だけ秒を出し、1 時間以上は時間と分にする", () => {
  assert.equal(formatActivityDuration(0), "0秒");
  assert.equal(formatActivityDuration(42_000), "42秒");
  assert.equal(formatActivityDuration(60_000), "1分");
  assert.equal(formatActivityDuration(18 * 60_000 + 24_000), "18分24秒");
  assert.equal(formatActivityDuration(3_600_000), "1時間");
  assert.equal(formatActivityDuration(3_720_000), "1時間2分");
});

test("状態ラベルは区分と終端の結末から決め、queued は実行中にまとめる", () => {
  const labelOf = (overrides: Partial<SessionSummary>) => {
    const [row] = activityRows([summary(overrides)], [], NOW);
    return activityStatusLabel(row);
  };
  assert.equal(labelOf({ status: "running", awaitingAnswer: true }), "回答待ち");
  assert.equal(labelOf({ status: "compacting" }), "圧縮中");
  assert.equal(labelOf({ status: "running" }), "実行中");
  assert.equal(labelOf({ status: "queued" }), "実行中");
  assert.equal(labelOf({ status: "completed", finishedAt: NOW - 1_000 }), "完了");
  assert.equal(labelOf({ status: "stopped", finishedAt: NOW - 1_000 }), "停止");
  assert.equal(labelOf({ status: "error", finishedAt: NOW - 1_000 }), "失敗");
});

test("所属プロジェクト名を出し、未所属・名前欠落・未知のスペースでも行を残す", () => {
  const projects: Project[] = [{ id: "project-1", cwd: "proj-a", name: "デモ", createdAt: 0 }];
  const rows = activityRows(
    [
      summary({ sessionId: "a", status: "running", projectId: "project-1" }),
      summary({ sessionId: "b", status: "running", projectId: "gone" }),
      summary({ sessionId: "c", status: "running", agentName: undefined, spaceId: "space-unknown" }),
    ],
    projects,
    NOW,
  );
  const byId = new Map(rows.map((row) => [row.sessionId, row]));
  assert.equal(byId.get("a")?.projectLabel, "デモ");
  assert.equal(byId.get("b")?.projectLabel, "未所属");
  assert.equal(byId.get("c")?.agentName, "エージェント名不明");
  assert.equal(byId.get("c")?.spaceId, "space-unknown");
});
