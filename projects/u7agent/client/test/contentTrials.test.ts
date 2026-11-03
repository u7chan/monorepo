// 設定 → コンテンツ生成の試行ジョブの表示変換（状態ラベル・証拠・タブの印・履歴の行）。
// DOM を使わない純関数だけを固定する（面の描画は contentSettingsTab.test.ts）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceNote,
  hasRunningTrial,
  imageTrialEvidence,
  latestTrial,
  newlyFinishedKinds,
  tabIndicator,
  trialAgeLabel,
  trialDurationLabel,
  trialFailureLabel,
  trialHistoryRow,
  trialKindSubsection,
  trialPanelState,
  trialStartBlockedReason,
  trialStateLabel,
} from "../src/lib/contentTrials";
import { imageScreenModel } from "../src/lib/contentSettings";
import type { ContentTrial } from "../src/types";

const MODEL = "openrouter/openai/gpt-image-2";
const OTHER_MODEL = "openrouter/black-forest-labs/flux.2-max";

function trial(overrides: Partial<ContentTrial> = {}): ContentTrial {
  return {
    id: "trial-1",
    kind: "image",
    model: MODEL,
    prompt: "a cat",
    state: "succeeded",
    keyEpoch: 1,
    artifactState: "none",
    failureCode: null,
    failureMessage: null,
    startedAt: 1_000,
    finishedAt: 12_000,
    durationMs: 11_000,
    recorded: true,
    ...overrides,
  };
}

test("状態の表示名は実行中 / 成功 / 失敗 / 中止 / 中断（再起動）", () => {
  assert.equal(trialStateLabel("running"), "実行中");
  assert.equal(trialStateLabel("succeeded"), "成功");
  assert.equal(trialStateLabel("failed"), "失敗");
  assert.equal(trialStateLabel("canceled"), "中止");
  assert.equal(trialStateLabel("interrupted"), "中断（再起動）");
});

test("失敗の分類は固定の短い名前へ写し、未知の値は原因不明にする", () => {
  assert.equal(trialFailureLabel("invalid_key"), "APIキーが無効");
  assert.equal(trialFailureLabel("rate_limited"), "混雑・レート制限");
  assert.equal(trialFailureLabel("nope"), "原因不明");
  assert.equal(trialFailureLabel(null), null);
});

test("証拠の時刻は分・時間・日で表し、1 週間より古いものは日付へ落とす", () => {
  const now = Date.UTC(2026, 4, 20, 12, 0, 0);
  assert.equal(trialAgeLabel(now - 10_000, now), "たった今");
  assert.equal(trialAgeLabel(now - 2 * 60_000, now), "2 分前");
  assert.equal(trialAgeLabel(now - 3 * 3_600_000, now), "3 時間前");
  assert.equal(trialAgeLabel(now - 5 * 86_400_000, now), "5 日前");
  // それ以前は日付（同じ年なら月日、年をまたぐと年も出す）
  assert.equal(trialAgeLabel(Date.UTC(2026, 0, 5, 0, 0, 0), now, { timeZone: "UTC" }), "1/5");
  assert.equal(trialAgeLabel(Date.UTC(2024, 0, 5, 0, 0, 0), now, { timeZone: "UTC" }), "2024/1/5");
});

test("所要時間は不明を — にし、分かるものだけ単位付きで出す", () => {
  assert.equal(trialDurationLabel(null), "—");
  assert.equal(trialDurationLabel(12_400), "12.4s");
  assert.equal(trialDurationLabel(120_000), "2.0m");
});

test("証拠は現在のキー世代と選択中モデルの実績だけを数える", () => {
  const now = 100_000;
  const evidence = imageTrialEvidence({
    trials: [
      trial({ id: "old-key", keyEpoch: 0, finishedAt: 90_000 }),
      trial({ id: "other-model", model: OTHER_MODEL, finishedAt: 95_000 }),
      trial({ id: "current", finishedAt: 60_000 }),
    ],
    currentKeyEpoch: 1,
    currentModel: MODEL,
    now,
  });
  assert.deepEqual(evidence, { kind: "success", at: 60_000, durationMs: 11_000 });
  assert.equal(evidenceNote(evidence, { now }), "この画面での最終成功: たった今（11.0s）。結果は保存されていません");
});

test("証拠と試行のモデルは画面の選択（下書き優先）で、保存値の実績は数えない", () => {
  const now = 100_000;
  // 画面は Gemini を選んでいるが、まだ保存していない（保存値は gpt-image-2）
  const savedModel = "openrouter/openai/gpt-image-2";
  const draft = "openrouter/google/gemini-image";
  const currentModel = imageScreenModel({ draft, savedModel });
  assert.equal(currentModel, draft);

  const trials = [
    trial({ id: "saved-model-success", model: savedModel, finishedAt: 90_000 }),
    trial({
      id: "draft-model-failure",
      model: draft,
      state: "failed",
      failureCode: "rate_limited",
      finishedAt: 95_000,
    }),
  ];
  // 開始本文と証拠が同じ値を使うので、保存値の成功を「この画面での最終成功」にしない
  assert.deepEqual(imageTrialEvidence({ trials, currentKeyEpoch: 1, currentModel, now }), {
    kind: "failure",
    at: 95_000,
    code: "rate_limited",
    message: null,
  });
  // 保存値のモデルで数えると別モデルの成功が証拠になる（以前の不具合）。その混同をここで固定する
  assert.deepEqual(imageTrialEvidence({ trials, currentKeyEpoch: 1, currentModel: savedModel, now }), {
    kind: "success",
    at: 90_000,
    durationMs: 11_000,
  });
});

test("成功が無ければ同じ条件の直近の失敗を出し、どちらも無ければ未確認にする", () => {
  const now = 200_000;
  const failed = imageTrialEvidence({
    trials: [
      trial({ state: "failed", failureCode: "invalid_key", finishedAt: 190_000, durationMs: 500 }),
      trial({ state: "canceled", failureCode: "aborted", finishedAt: 195_000 }),
    ],
    currentKeyEpoch: 1,
    currentModel: MODEL,
    now,
  });
  assert.deepEqual(failed, {
    kind: "failure",
    at: 190_000,
    code: "invalid_key",
    message: null,
  });
  assert.equal(evidenceNote(failed, { now }), "直近の失敗: APIキーが無効（たった今）");

  const unverified = imageTrialEvidence({
    trials: [trial({ keyEpoch: 0 })],
    currentKeyEpoch: 2,
    currentModel: MODEL,
    now,
  });
  assert.deepEqual(unverified, { kind: "unverified" });
  assert.equal(evidenceNote(unverified, { now }), "この画面での成功: 未確認");
});

test("失敗の分類を出すのは failed だけ（中止・中断を失敗の分類として見せない）", () => {
  const canceled = trialHistoryRow(trial({ state: "canceled", failureCode: "aborted" }), 1);
  assert.equal(canceled.stateLabel, "中止");
  assert.equal(canceled.failureLabel, null);
  const interrupted = trialHistoryRow(trial({ state: "interrupted", failureCode: null }), 1);
  assert.equal(interrupted.stateLabel, "中断（再起動）");
  assert.equal(interrupted.failureLabel, null);
  const failed = trialHistoryRow(trial({ state: "failed", failureCode: "timeout" }), 1);
  assert.equal(failed.failureLabel, "タイムアウト");
});

test("履歴の行は現在より古いキー世代を「旧キー」として区別する", () => {
  const row = trialHistoryRow(trial({ keyEpoch: 1 }), 2);
  assert.equal(row.stateLabel, "成功");
  assert.equal(row.durationLabel, "11.0s");
  assert.equal(row.keyEpochLabel, "旧キー（世代 1）");
  assert.equal(row.prompt, "a cat");
  assert.equal(trialHistoryRow(trial({ keyEpoch: 2 }), 2).keyEpochLabel, null);
});

test("面の状態は runtime 不可 → 未設定 → 同期未確認 → 全体 OFF → 実行中 → 空 の順に決まる", () => {
  const base = { runtimeAvailable: true, configured: true, enabled: true, synced: true, trials: [] as ContentTrial[] };
  assert.equal(trialPanelState({ ...base, runtimeAvailable: false, configured: false }), "runtime_unavailable");
  assert.equal(trialPanelState({ ...base, configured: false, enabled: false }), "unconfigured");
  assert.equal(trialPanelState({ ...base, synced: false, enabled: false }), "unsynced");
  assert.equal(trialPanelState({ ...base, enabled: false }), "disabled");
  assert.equal(trialPanelState({ ...base, trials: [trial({ state: "running", finishedAt: null })] }), "running");
  assert.equal(trialPanelState(base), "empty");
  assert.equal(trialPanelState({ ...base, trials: [trial({ state: "failed" })] }), "failed");
  assert.equal(trialPanelState({ ...base, trials: [trial({ state: "interrupted" })] }), "interrupted");
  assert.equal(trialPanelState({ ...base, trials: [trial()] }), "ready");
});

test("試行の開始を止める理由は上から順に 1 つだけ返し、問題が無ければ null", () => {
  const base = {
    runtimeAvailable: true,
    configured: true,
    enabled: true,
    keyAvailable: true,
    running: false,
    prompt: "a cat",
  };
  assert.equal(trialStartBlockedReason(base), null);
  assert.match(trialStartBlockedReason({ ...base, runtimeAvailable: false }) ?? "", /ランタイム/);
  assert.match(trialStartBlockedReason({ ...base, configured: false }) ?? "", /APIキーを登録/);
  assert.match(trialStartBlockedReason({ ...base, enabled: false }) ?? "", /全体が OFF/);
  assert.match(trialStartBlockedReason({ ...base, keyAvailable: false }) ?? "", /保存済みのAPIキー/);
  assert.match(trialStartBlockedReason({ ...base, running: true }) ?? "", /実行中/);
  assert.match(trialStartBlockedReason({ ...base, prompt: "   " }) ?? "", /プロンプトを入力/);
});

test("タブの印は 実行中 > 同期未確認 > 新着結果 の順に 1 つだけ出す", () => {
  assert.deepEqual(tabIndicator({ label: "画像生成", running: true, unsynced: true, newResult: true }), {
    dot: "accent",
    pulse: true,
    ariaLabel: "画像生成（生成中）",
  });
  assert.deepEqual(tabIndicator({ label: "音声（TTS）", running: false, unsynced: true, newResult: true }), {
    dot: "warn",
    pulse: false,
    ariaLabel: "音声（TTS）（現在の設定を確認できません）",
  });
  assert.deepEqual(tabIndicator({ label: "画像生成", running: false, unsynced: false, newResult: true }), {
    dot: "warn",
    pulse: false,
    ariaLabel: "画像生成（新しい結果があります）",
  });
  assert.deepEqual(tabIndicator({ label: "画像生成", running: false, unsynced: false, newResult: false }), {
    dot: null,
    pulse: false,
    ariaLabel: null,
  });
});

test("新着結果は、前回 running だった行が終端になり、そのタブを開いていなければ印を出す", () => {
  const running = trial({ id: "a", state: "running", finishedAt: null, durationMs: null });
  const done = trial({ id: "a" });
  // ページ再訪時（前回の一覧が無い）は出さない
  assert.deepEqual(newlyFinishedKinds({ previous: null, next: [done], activeSubsection: "speech" }), []);
  // 開いているタブなら出さない
  assert.deepEqual(newlyFinishedKinds({ previous: [running], next: [done], activeSubsection: "image" }), []);
  // 別のタブで終端したら出す
  assert.deepEqual(newlyFinishedKinds({ previous: [running], next: [done], activeSubsection: "speech" }), ["image"]);
  // 前回から終端していた行は新しい結果にしない
  assert.deepEqual(newlyFinishedKinds({ previous: [done], next: [done], activeSubsection: "speech" }), []);
});

test("実行中の有無と最新の試行は一覧の先頭だけで決める", () => {
  assert.equal(hasRunningTrial([]), false);
  assert.equal(hasRunningTrial([trial({ state: "running" })]), true);
  assert.equal(latestTrial([]), null);
  assert.equal(latestTrial([trial({ id: "new" }), trial({ id: "old" })])?.id, "new");
});

test("試行の種別は設定タブの面へ写す", () => {
  assert.equal(trialKindSubsection("image"), "image");
});
