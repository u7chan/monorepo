// 入力欄のマイクの可用性（client/src/lib/voiceInput/availability.ts）。キー未設定・復号不能・
// 非 secure context・取得失敗でマイクを出さないことを固定する。理由の表示は設定画面の注記が持つ。
import assert from "node:assert/strict";
import test from "node:test";
import {
  voiceInputAvailability,
  voiceInputMicrophoneShown,
  type VoiceInputAvailabilityInput,
} from "../src/lib/voiceInput/availability";

const key = { keyStored: true, keyAvailable: true, runtimeAvailable: true };

const at = (input: Partial<VoiceInputAvailabilityInput>): string =>
  voiceInputAvailability({ settings: key, failed: false, secureContext: true, ...input });

test("キーが使えればマイクを出す", () => {
  assert.equal(at({}), "available");
  assert.equal(voiceInputMicrophoneShown("available"), true);
});

test("キー未設定では出さない", () => {
  assert.equal(at({ settings: { ...key, keyStored: false, keyAvailable: false } }), "no-key");
});

test("保存はあるが復号できないキーでは出さない", () => {
  // 未設定と同じ見た目にせず、設定画面で理由 (keyErrorMessage) を読める状態として区別する
  assert.equal(at({ settings: { ...key, keyAvailable: false } }), "key-unavailable");
});

test("マスカーを持てない起動では出さない", () => {
  // セッションの開始が 503 になるため、押しても始まらないマイクを出さない
  assert.equal(at({ settings: { ...key, runtimeAvailable: false } }), "runtime-unavailable");
});

test("HTTPS でも localhost でもないオリジンではキーの状態によらず出さない", () => {
  assert.equal(at({ secureContext: false }), "insecure-context");
  assert.equal(at({ secureContext: false, settings: null, failed: true }), "insecure-context");
});

test("取得前と取得失敗は出さない", () => {
  assert.equal(at({ settings: null }), "loading");
  assert.equal(at({ settings: null, failed: true }), "unknown");
});

test("使えない理由はすべてマイクを出さない側に倒す", () => {
  for (const availability of [
    "loading",
    "unknown",
    "insecure-context",
    "no-key",
    "key-unavailable",
    "runtime-unavailable",
  ] as const) {
    assert.equal(voiceInputMicrophoneShown(availability), false, availability);
  }
});
