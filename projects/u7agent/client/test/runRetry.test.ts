import assert from "node:assert/strict";

import test from "node:test";
import {
  blockedButtonsNotice,
  retryableRunError,
  runErrorFrom,
  runRetryBlockedReason,
  RUN_RETRY_LABEL,
  RUN_RETRY_LABEL_COMPACT,
  RUN_RETRY_NOTE,
  RUN_RETRY_PROMPT,
  type RunErrorInfo,
} from "../src/lib/runRetry";

const error = (code: RunErrorInfo["code"], text = "レート制限により実行に失敗しました"): RunErrorInfo => ({
  code,
  text,
});

// --- 文言 ---

test("再実行は直前のターンを再実行する API が無いため、続きを促す固定文言を送る", () => {
  assert.equal(RUN_RETRY_PROMPT, "前回の続きから再開してください");
});

test("ラベルはデスクトップで短くし、compact は送信内容を兼ねる", () => {
  assert.equal(RUN_RETRY_LABEL, "再実行");
  assert.equal(RUN_RETRY_LABEL_COMPACT, "再実行（前回の続きから送信）");
  assert.ok(RUN_RETRY_LABEL_COMPACT.startsWith(RUN_RETRY_LABEL), "ボタンの名前は同じ「再実行」");
  assert.ok(RUN_RETRY_LABEL_COMPACT.includes("前回の続きから送信"), "compact はラベルで送信内容を示す");
  assert.equal(RUN_RETRY_NOTE, "前回の続きから送信します");
});

// --- 表示条件 ---

test("再実行カードは時間をおけば回復し得る分類だけに出す", () => {
  assert.deepEqual(retryableRunError("error", error("rate_limit")), error("rate_limit"));
  assert.deepEqual(retryableRunError("error", error("unknown")), error("unknown"));
  for (const code of ["auth_required", "insufficient_quota", "context_overflow"] as const) {
    assert.equal(retryableRunError("error", error(code)), undefined, `${code} は同じ送信では直らない`);
  }
  assert.equal(retryableRunError("error", undefined), undefined, "分類コードが無い縮退では出さない");
});

test("カードは runStatus が error のときだけ出す (キュー待ちと停止では出さない)", () => {
  for (const status of ["idle", "running", "queued", "compacting", "completed", "stopped"] as const) {
    assert.equal(retryableRunError(status, error("rate_limit")), undefined, `${status} では出さない`);
  }
});

test("保持する失敗は status === error のときだけ作る", () => {
  assert.deepEqual(runErrorFrom("error", "rate_limit", "レート制限です"), {
    code: "rate_limit",
    text: "レート制限です",
  });
  assert.deepEqual(runErrorFrom("error", "unknown", undefined), { code: "unknown", text: "実行に失敗しました" });
  assert.equal(runErrorFrom("stopped", "rate_limit", "レート制限です"), undefined, "停止を正とする");
  assert.equal(runErrorFrom("error", undefined, "旧 payload の文言"), undefined, "コードが無ければカードを出さない");
});

// --- 押せない理由 ---

test("再実行のガードは送信経路と同じ順で、実際に遮っている理由を返す", () => {
  const open = { sending: false, settingsChanging: false, attachmentsBusy: false, runtimeReady: true };
  assert.equal(runRetryBlockedReason(open), undefined);
  assert.equal(runRetryBlockedReason({ ...open, sending: true }), "送信中");
  assert.equal(runRetryBlockedReason({ ...open, sending: true, settingsChanging: true }), "送信中");
  assert.equal(runRetryBlockedReason({ ...open, settingsChanging: true }), "設定の変更中");
  assert.equal(runRetryBlockedReason({ ...open, attachmentsBusy: true }), "添付のアップロード中");
  assert.equal(runRetryBlockedReason({ ...open, runtimeReady: false }), "ランタイム未接続");
});

test("押せない理由の行は無効な操作の名前を実際のものに揃える", () => {
  assert.equal(blockedButtonsNotice({}), undefined);
  assert.equal(blockedButtonsNotice({ compact: "実行中" }), "今は圧縮できません（実行中）");
  assert.equal(
    blockedButtonsNotice({ retry: "添付のアップロード中" }),
    "今は再実行できません（添付のアップロード中）",
    "再実行だけが無効なときに圧縮を押せないと誤案内しない",
  );
  assert.equal(
    blockedButtonsNotice({ compact: "送信中", retry: "送信中" }),
    "今は圧縮も再実行もできません（送信中）",
    "同じ理由は 1 つに畳む",
  );
  assert.equal(
    blockedButtonsNotice({ compact: "実行中", retry: "添付のアップロード中" }),
    "今は圧縮も再実行もできません（実行中・添付のアップロード中）",
  );
});

// --- 配線 ---
