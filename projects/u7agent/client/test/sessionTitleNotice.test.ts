import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_SESSION_TITLE_NOTICE_TRACKER,
  nextSessionTitleNotice,
  type SessionTitleNoticeTracker,
} from "../src/lib/sessionTitleNotice";
import type { SessionTitleSummary } from "../src/types";

function summary(
  state: "pending" | "done" | "failed" | "skipped",
  at = 1000,
  extra: Partial<NonNullable<SessionTitleSummary["attempt"]>> = {},
): SessionTitleSummary {
  return { origin: "ai", attempt: { runId: "r-1", at, state, ...extra } };
}

function step(
  tracker: SessionTitleNoticeTracker,
  titleSummary: SessionTitleSummary | undefined,
  sessionId = "s-1",
  title = "タイトル",
) {
  return nextSessionTitleNotice(tracker, { sessionId, title, titleSummary });
}

test("会話を開いた時点で終わっている試行はお知らせしない", () => {
  const opened = step(INITIAL_SESSION_TITLE_NOTICE_TRACKER, summary("done"));
  assert.equal(opened.notice, null);
  assert.equal(opened.reset, true);
  assert.equal(opened.tracker.seenKey, "r-1:done");

  // 同じ会話を再描画しても出さない
  const again = step(opened.tracker, summary("done"));
  assert.equal(again.notice, null);
  assert.equal(again.reset, false);
});

test("pending から done / failed に変わったときだけお知らせする", () => {
  const opened = step(INITIAL_SESSION_TITLE_NOTICE_TRACKER, summary("pending"));
  assert.equal(opened.notice, null);
  const done = step(opened.tracker, summary("done"));
  assert.equal(done.notice?.heading, "タイトルをAI要約で更新しました");
  assert.equal(done.notice?.detail, "タイトル");

  const nextPending = step(done.tracker, summary("pending", 2000));
  assert.equal(nextPending.notice, null);
  const failed = step(nextPending.tracker, summary("failed", 2000, { error: "rate limited" }));
  assert.equal(failed.notice?.heading, "AI要約に失敗しました");
  assert.equal(failed.notice?.detail, "rate limited");
});

test("スキップはお知らせせず、会話の切替で表示中のお知らせを消す", () => {
  const opened = step(INITIAL_SESSION_TITLE_NOTICE_TRACKER, summary("pending"));
  const skipped = step(opened.tracker, summary("skipped", 1000, { skipReason: "disabled" }));
  assert.equal(skipped.notice, null);
  assert.equal(skipped.tracker.seenKey, "r-1:skipped");

  const done = step(INITIAL_SESSION_TITLE_NOTICE_TRACKER, summary("pending"));
  const shown = step(done.tracker, summary("done"));
  assert.ok(shown.notice);
  const switched = step(shown.tracker, summary("done"), "s-2");
  assert.equal(switched.notice, null);
  assert.equal(switched.reset, true);
});

test("閉じたお知らせは同じ試行では出さず、次の試行では出す", () => {
  const pending = step(INITIAL_SESSION_TITLE_NOTICE_TRACKER, summary("pending"));
  const shown = step(pending.tracker, summary("done"));
  const dismissed = { ...shown.tracker, dismissedKey: shown.notice!.key };
  const same = step(dismissed, summary("done"));
  assert.equal(same.notice, null);

  const nextPending = step(same.tracker, summary("pending", 3000, { runId: "r-2" }));
  const nextDone = step(nextPending.tracker, summary("done", 3000, { runId: "r-2" }));
  assert.equal(nextDone.notice?.heading, "タイトルをAI要約で更新しました");
});
