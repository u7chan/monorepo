import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionTitleNoticeText,
  sessionTitleResummarizeConfirmRequest,
  sessionTitleSkipReasonText,
  sessionTitleStatusOf,
} from "../src/lib/sessionTitleStatus";
import type { SessionTitleSummary } from "../src/types";

function summary(
  state: "pending" | "done" | "failed" | "skipped",
  extra: Partial<NonNullable<SessionTitleSummary["attempt"]>> = {},
): SessionTitleSummary {
  return {
    origin: "ai",
    attempt: { runId: "r-1", at: 1000, state, ...extra },
  };
}

test("AI要約の状態は点と文字で表し、実行中 / 済み / 失敗 / スキップを区別する", () => {
  assert.deepEqual(sessionTitleStatusOf(undefined), { text: "未実行", tone: "muted" });
  assert.deepEqual(sessionTitleStatusOf(summary("pending")), {
    text: "実行中",
    tone: "warn",
    description: "AI要約を実行しています",
  });
  assert.deepEqual(sessionTitleStatusOf(summary("done")), {
    text: "済み",
    tone: "accent",
    description: "AI要約でタイトルを更新しました",
  });
  assert.deepEqual(sessionTitleStatusOf(summary("failed", { error: "rate limited" })), {
    text: "失敗",
    tone: "danger",
    description: "AI要約に失敗しました: rate limited",
  });
  assert.equal(sessionTitleStatusOf(summary("skipped", { skipReason: "disabled" })).text, "無効");
  assert.equal(sessionTitleStatusOf(summary("skipped", { skipReason: "manual" })).text, "スキップ");
});

test("スキップ理由は画面で使う 1 文へ写す", () => {
  assert.equal(sessionTitleSkipReasonText("disabled"), "AI要約は Off です");
  assert.equal(sessionTitleSkipReasonText("model-unset"), "要約モデルが選択されていません");
  assert.equal(sessionTitleSkipReasonText("manual"), "手動で変更したタイトルを保護しました");
  assert.equal(sessionTitleSkipReasonText("no-request"), "依頼本文がないため対象外です");
  assert.equal(sessionTitleSkipReasonText("cancelled"), "設定の変更または停止で取り消しました");
  assert.equal(sessionTitleSkipReasonText("settings-changed"), "設定が変わったため結果を適用しませんでした");
  assert.equal(sessionTitleSkipReasonText("not-ready"), "会話が実行中のためスキップしました");
  assert.equal(sessionTitleSkipReasonText("interrupted"), "再起動で中断しました");
  assert.equal(sessionTitleSkipReasonText(undefined), "要約の対象外です");
});

test("完了のお知らせは成功時に現在のタイトル、失敗時に理由を出す", () => {
  assert.deepEqual(sessionTitleNoticeText(summary("done"), "新しいタイトル"), {
    heading: "タイトルをAI要約で更新しました",
    detail: "新しいタイトル",
    tone: "accent",
  });
  assert.deepEqual(sessionTitleNoticeText(summary("failed", { error: "rate limited" }), "仮タイトル"), {
    heading: "AI要約に失敗しました",
    detail: "rate limited",
    tone: "danger",
  });
  const skipped = sessionTitleNoticeText(summary("skipped", { skipReason: "disabled" }), "仮タイトル");
  assert.equal(skipped.heading, "AI要約をスキップしました");
  assert.equal(skipped.detail, "AI要約は Off です");
});

test("再要約の確認は手動タイトルを置き換えることを押す前に伝える", () => {
  const manual = sessionTitleResummarizeConfirmRequest("手動の名前", { origin: "manual" });
  assert.equal(manual.kind, "confirm");
  assert.deepEqual(manual.subject, { label: "対象の会話", value: "手動の名前" });
  assert.ok(manual.body?.some((line) => line.includes("手動で変更したタイトルを")));
  assert.equal(manual.confirmLabel, "再要約する");

  const auto = sessionTitleResummarizeConfirmRequest("仮タイトル", { origin: "auto" });
  assert.ok(auto.body?.some((line) => line.includes("現在のタイトルを")));
  assert.ok(!auto.body?.some((line) => line.includes("手動で変更したタイトルを")));
});
