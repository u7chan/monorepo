// 設定 → 音声入力の表示変換と入力検証（純関数）。キーの状態はサーバーの DTO をそのまま入力にする。
import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteVoiceInputKeyConfirmRequest,
  runVoiceInputTest,
  VOICE_INPUT_KEY_MAX_LENGTH,
  VOICE_INPUT_KEY_MIN_LENGTH,
  VOICE_INPUT_RETENTION_NOTICE,
  voiceInputBillingNotice,
  voiceInputDeletedNote,
  voiceInputKeyBadge,
  voiceInputKeyCanSave,
  voiceInputKeyError,
  voiceInputKeyErrorNotice,
  voiceInputModelNote,
  voiceInputRuntimeNotice,
  voiceInputSavedNote,
  voiceInputSecureContextNotice,
  voiceInputTestDisabledReason,
  voiceInputTestFailure,
  voiceInputTestSummary,
} from "../src/lib/voiceInputSettings";
import type { VoiceInputSettingsResponse } from "../src/types";

const base: VoiceInputSettingsResponse = {
  configured: false,
  keyStored: false,
  keyAvailable: false,
  keyEvaluated: true,
  keyErrorMessage: null,
  model: "gpt-live-transcribe",
  runtimeAvailable: true,
};

const stored = (overrides: Partial<VoiceInputSettingsResponse> = {}): VoiceInputSettingsResponse => ({
  ...base,
  configured: true,
  keyStored: true,
  ...overrides,
});

test("キーの状態は未設定 / 利用可 / 保存あり・利用不可を別のバッジにする", () => {
  assert.deepEqual(voiceInputKeyBadge(base), { label: "未設定", tone: "muted" });
  assert.deepEqual(voiceInputKeyBadge(stored({ keyAvailable: true })), { label: "利用可", tone: "ok" });
  assert.deepEqual(voiceInputKeyBadge(stored({ keyAvailable: false })), { label: "利用不可", tone: "warn" });
});

test("復号できないキーの理由は、保存があるときだけサーバーの固定文言を出す", () => {
  assert.equal(voiceInputKeyErrorNotice(base), null);
  assert.equal(voiceInputKeyErrorNotice(stored({ keyAvailable: true })), null);
  assert.equal(
    voiceInputKeyErrorNotice(stored({ keyAvailable: false, keyErrorMessage: "再入力してください" })),
    "再入力してください",
  );
});

test("フォームの送信可否は空・長さ・文字種・ランタイム・保存中で決まる", () => {
  assert.equal(voiceInputKeyError(""), "音声入力のAPIキーを入力してください。");
  assert.equal(
    voiceInputKeyError("a".repeat(VOICE_INPUT_KEY_MIN_LENGTH - 1)),
    `APIキーは ${VOICE_INPUT_KEY_MIN_LENGTH} 文字以上で入力してください。`,
  );
  assert.equal(
    voiceInputKeyError("a".repeat(VOICE_INPUT_KEY_MAX_LENGTH + 1)),
    `APIキーは ${VOICE_INPUT_KEY_MAX_LENGTH} 文字以内で入力してください。`,
  );
  assert.equal(
    voiceInputKeyError("sk-voice\nkey-0123456789"),
    "APIキーは改行や制御文字を含まない、印字可能な半角の文字で入力してください。",
  );
  assert.equal(
    voiceInputKeyError("sk-voice-key-日本語"),
    "APIキーは改行や制御文字を含まない、印字可能な半角の文字で入力してください。",
  );
  assert.equal(voiceInputKeyError("a".repeat(VOICE_INPUT_KEY_MIN_LENGTH)), undefined);
  assert.equal(voiceInputKeyError("a".repeat(VOICE_INPUT_KEY_MAX_LENGTH)), undefined);

  assert.equal(voiceInputKeyCanSave(base, "a".repeat(8), false), true);
  assert.equal(voiceInputKeyCanSave({ ...base, runtimeAvailable: false }, "a".repeat(8), false), false);
  assert.equal(voiceInputKeyCanSave(base, "a".repeat(8), true), false, "保存中は送らない");
  assert.equal(voiceInputKeyCanSave(base, "short", false), false);
});

test("ランタイムが無い起動は削除だけができることを伝える", () => {
  assert.equal(voiceInputRuntimeNotice(base), null);
  const notice = voiceInputRuntimeNotice({ ...base, runtimeAvailable: false });
  assert.ok(notice);
  assert.ok(notice.includes("削除だけは行えます"));
});

test("疎通確認を押せない理由は未設定・利用不可・ランタイムの順で 1 つに決まる", () => {
  assert.equal(voiceInputTestDisabledReason(base), "APIキーを登録すると疎通確認できます。");
  assert.equal(
    voiceInputTestDisabledReason(stored({ keyAvailable: false, keyErrorMessage: "再入力してください" })),
    "再入力してください",
  );
  assert.equal(
    voiceInputTestDisabledReason(stored({ keyAvailable: false, keyErrorMessage: null })),
    "保存済みのAPIキーを使える状態ではありません。",
  );
  assert.equal(
    voiceInputTestDisabledReason({ ...stored({ keyAvailable: true }), runtimeAvailable: false }),
    "ランタイムが利用できないため、疎通確認はできません。",
  );
  assert.equal(voiceInputTestDisabledReason(stored({ keyAvailable: true })), undefined);
});

test("疎通結果の 1 行は成功ならモデル、失敗なら文言と分類を出す", () => {
  assert.equal(
    voiceInputTestSummary({ ok: true, model: "gpt-live-transcribe" }),
    "接続できました（モデル gpt-live-transcribe）",
  );
  assert.equal(
    voiceInputTestSummary({ ok: false, code: "insufficient_credit", message: "残高が不足しています" }),
    "残高が不足しています（残高不足）",
  );
  assert.equal(
    voiceInputTestSummary({ ok: false, code: "rate_limited", message: "OpenAI が混雑しています" }),
    "OpenAI が混雑しています（混雑）",
  );
  assert.equal(
    voiceInputTestSummary({ ok: false, code: "invalid_key", message: "キーが拒否されました" }),
    "キーが拒否されました（キー無効）",
  );
  assert.equal(voiceInputTestSummary({ ok: false, code: "unknown", message: "通信できません" }), "通信できません");
});

test("疎通確認の通信失敗は結果と同じ形へ畳み、結果はそのまま返す", async () => {
  const failure = voiceInputTestFailure("アプリデータ（SQLite）を利用できません");
  assert.deepEqual(failure, { ok: false, code: "unknown", message: "アプリデータ（SQLite）を利用できません" });

  const result = { ok: true as const, model: "gpt-live-transcribe" };
  assert.deepEqual(await runVoiceInputTest(async () => result), result);
  assert.deepEqual(
    await runVoiceInputTest(async () => {
      throw new Error("通信できません");
    }),
    { ok: false, code: "unknown", message: "通信できません" },
  );
});

test("secure context でないオリジンだけ、マイクが使えないことを明示する", () => {
  assert.equal(voiceInputSecureContextNotice(true), null);
  const notice = voiceInputSecureContextNotice(false);
  assert.ok(notice);
  assert.ok(notice.includes("HTTPS か localhost"));
});

test("課金・保存しない範囲・モデルの文言は対象を隠さない", () => {
  assert.ok(voiceInputBillingNotice("gpt-live-transcribe").includes("gpt-live-transcribe"));
  assert.ok(voiceInputBillingNotice("gpt-live-transcribe").includes("利用料"));
  assert.ok(VOICE_INPUT_RETENTION_NOTICE.includes("永続化しません"));
  assert.ok(VOICE_INPUT_RETENTION_NOTICE.includes("自動送信はしません"));
  assert.ok(voiceInputModelNote("gpt-live-transcribe").includes("固定"));
});

test("保存・削除の注記と削除の確認は再登録できることを伝える", () => {
  assert.ok(voiceInputSavedNote().includes("保存しました"));
  assert.ok(voiceInputDeletedNote().includes("削除しました"));
  const request = deleteVoiceInputKeyConfirmRequest();
  assert.equal(request.confirmLabel, "削除する");
  assert.equal(request.danger, undefined, "再登録できる操作は danger にしない");
  assert.ok(request.body?.some((line) => line.includes("再登録")));
});
