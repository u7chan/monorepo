// 設定 → 音声入力のプレイグラウンド（client/src/lib/voiceInput/playground.ts と
// client/src/components/voice-input-settings/VoiceInputPlayground.tsx）。録音そのものは fake にし、
// 表示の出し分け・計測値・終了の導線・保存しないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceInputPlayground } from "../src/components/voice-input-settings/VoiceInputPlayground";
import {
  createVoiceInputPlayground,
  formatVoiceInputMs,
  formatVoiceInputSeconds,
  INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
  voiceInputFailureLabel,
  voiceInputPlaygroundBusy,
  voiceInputPlaygroundCanStop,
  voiceInputPlaygroundStatus,
  type VoiceInputPlaygroundState,
} from "../src/lib/voiceInput/playground";
import type { VoiceInputCallbacks, VoiceInputFailureCode } from "../src/lib/voiceInput/session";

/** 録音 1 回分の fake。`start` は呼ばれた順にコールバックを溜める */
function playground() {
  const callbacks: VoiceInputCallbacks[] = [];
  const captures: { stops: number; cancels: number }[] = [];
  const states: VoiceInputPlaygroundState[] = [];
  const clock = { value: 0 };
  let unloaded: (() => void) | null = null;
  let unsubscribes = 0;
  const controller = createVoiceInputPlayground({
    start: (callback) => {
      callbacks.push(callback);
      const capture = { stops: 0, cancels: 0 };
      captures.push(capture);
      return {
        stop: () => {
          capture.stops += 1;
        },
        cancel: () => {
          capture.cancels += 1;
        },
      };
    },
    now: () => clock.value,
    subscribeUnload: (listener) => {
      unloaded = listener;
      return () => {
        unsubscribes += 1;
      };
    },
    onChange: (state) => states.push(state),
  });
  return {
    controller,
    clock,
    callbacks,
    captures,
    states,
    latest: () => states.at(-1) ?? INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
    unload: () => unloaded?.(),
    unsubscribes: () => unsubscribes,
  };
}

test("接続から確定までを 1 面に表示し、録音秒数と 2 つの待ち時間を計測する", () => {
  const p = playground();
  p.clock.value = 1_000;
  p.controller.start();
  assert.equal(p.latest().phase, "connecting");
  const callback = p.callbacks[0];
  assert.ok(callback);

  p.clock.value = 1_100;
  callback.onConnecting();
  assert.equal(p.latest().phase, "connecting");
  callback.onRecording({ startedAt: 1_000, deadline: 121_000 });
  assert.equal(p.latest().phase, "recording");
  assert.equal(p.latest().transcript, "");

  p.clock.value = 1_850;
  callback.onPartial("青い");
  p.clock.value = 2_400;
  callback.onPartial("青い傘");
  assert.equal(p.latest().partial, "青い傘");
  // 最初の途中表示までの時間は、2 回目以降の delta で上書きしない
  assert.equal(p.latest().firstPartialMs, 850);

  p.clock.value = 4_000;
  callback.onFinalizing({ reason: "manual", stoppedAt: 4_000 });
  assert.equal(p.latest().phase, "finalizing");
  assert.equal(p.latest().stopReason, "manual");
  assert.equal(p.latest().partial, "");
  assert.equal(p.latest().recordedSeconds, 3);

  p.clock.value = 5_200;
  callback.onFinal({ text: "青い傘を持って。", audioSeconds: 12 });
  assert.deepEqual(p.latest(), {
    ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
    phase: "done",
    stopReason: "manual",
    transcript: "青い傘を持って。",
    recordedSeconds: 3,
    firstPartialMs: 850,
    stopToFinalMs: 1_200,
  });
  assert.equal(p.captures[0]?.stops, 0);
});

test("上限で自動停止したことも、停止の理由として表示に残す", () => {
  const p = playground();
  p.controller.start();
  const callback = p.callbacks[0];
  assert.ok(callback);
  callback.onRecording({ startedAt: 0, deadline: 120_000 });
  callback.onFinalizing({ reason: "limit", stoppedAt: 120_000 });
  assert.equal(p.latest().stopReason, "limit");
  assert.match(voiceInputPlaygroundStatus(p.latest()), /上限の 120 秒で自動停止/);
});

test("失敗は分類と文言を残し、途中テキストは捨てる", () => {
  const p = playground();
  p.controller.start();
  const callback = p.callbacks[0];
  assert.ok(callback);
  callback.onRecording({ startedAt: 0, deadline: 120_000 });
  callback.onPartial("青い");
  callback.onError({ code: "insufficient-credit", message: "OpenAI の残高が不足しています。" });
  assert.equal(p.latest().phase, "error");
  assert.equal(p.latest().partial, "");
  assert.deepEqual(p.latest().failure, {
    code: "insufficient-credit",
    message: "OpenAI の残高が不足しています。",
  });
  assert.equal(voiceInputFailureLabel("insufficient-credit"), "残高不足");
});

test("キャンセルすると初期状態へ戻り、録音中の capture を止める", () => {
  const p = playground();
  p.controller.start();
  const callback = p.callbacks[0];
  assert.ok(callback);
  callback.onRecording({ startedAt: 0, deadline: 120_000 });
  callback.onPartial("青い");
  p.controller.cancel();
  assert.deepEqual(p.latest(), INITIAL_VOICE_INPUT_PLAYGROUND_STATE);
  assert.equal(p.captures[0]?.cancels, 1);
});

test("前の録音から遅れて届いたコールバックは、新しい録音の状態を変えない", () => {
  const p = playground();
  p.controller.start();
  const first = p.callbacks[0];
  assert.ok(first);
  first.onRecording({ startedAt: 0, deadline: 120_000 });
  p.controller.cancel();

  p.controller.start();
  const second = p.callbacks[1];
  assert.ok(second);
  second.onRecording({ startedAt: 5, deadline: 125_000 });
  second.onPartial("新しい途中");
  const current = p.latest();

  // 世代が古い capture の遅延コールバック（確定・失敗・途中）は捨てる
  first.onPartial("古い途中");
  first.onFinalizing({ reason: "manual", stoppedAt: 10 });
  first.onFinal({ text: "古い確定", audioSeconds: null });
  first.onError({ code: "connection-closed", message: "古い失敗" });
  assert.deepEqual(p.latest(), current);
  assert.equal(p.latest().partial, "新しい途中");
});

test("画面を離れる通知（pagehide）で録音を中止する", () => {
  const p = playground();
  p.controller.start();
  const callback = p.callbacks[0];
  assert.ok(callback);
  callback.onRecording({ startedAt: 0, deadline: 120_000 });
  p.unload();
  assert.deepEqual(p.latest(), INITIAL_VOICE_INPUT_PLAYGROUND_STATE);
  assert.equal(p.captures[0]?.cancels, 1);
});

test("dispose は購読を解除し、録音を中止する", () => {
  const p = playground();
  p.controller.start();
  p.controller.dispose();
  assert.equal(p.unsubscribes(), 1);
  assert.equal(p.captures[0]?.cancels, 1);
  assert.deepEqual(p.latest(), INITIAL_VOICE_INPUT_PLAYGROUND_STATE);
});

test("2 回目の開始で、前回の確定テキスト・計測値・失敗を消す", () => {
  const p = playground();
  p.controller.start();
  const first = p.callbacks[0];
  assert.ok(first);
  first.onRecording({ startedAt: 0, deadline: 120_000 });
  first.onError({ code: "microphone-denied", message: "マイクを許可してください。" });
  assert.notEqual(p.latest().failure, null);
  p.controller.start();
  assert.equal(p.latest().phase, "connecting");
  assert.equal(p.latest().failure, null);
  assert.equal(p.latest().transcript, "");
  assert.equal(p.latest().partial, "");
});

test("録音中に開始を押しても、2 本目の録音は始めない", () => {
  const p = playground();
  p.controller.start();
  const callback = p.callbacks[0];
  assert.ok(callback);
  callback.onRecording({ startedAt: 0, deadline: 120_000 });
  p.controller.start();
  assert.equal(p.callbacks.length, 1);
});

test("停止は録音中だけ受け付け、接続中はキャンセルする（ボタンの出し分け）", () => {
  const phase = (value: VoiceInputPlaygroundState["phase"]): VoiceInputPlaygroundState => ({
    ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
    phase: value,
  });
  assert.equal(voiceInputPlaygroundBusy(phase("idle")), false);
  assert.equal(voiceInputPlaygroundBusy(phase("connecting")), true);
  assert.equal(voiceInputPlaygroundBusy(phase("recording")), true);
  assert.equal(voiceInputPlaygroundBusy(phase("finalizing")), true);
  assert.equal(voiceInputPlaygroundBusy(phase("done")), false);
  assert.equal(voiceInputPlaygroundBusy(phase("error")), false);
  assert.equal(voiceInputPlaygroundCanStop(phase("recording")), true);
  assert.equal(voiceInputPlaygroundCanStop(phase("connecting")), false);
  assert.equal(voiceInputPlaygroundCanStop(phase("finalizing")), false);
});

test("状態の 1 行は、録音前・接続中・録音中・確定待ち・確定・失敗で変わる", () => {
  const status = (state: Partial<VoiceInputPlaygroundState>): string =>
    voiceInputPlaygroundStatus({ ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE, ...state });
  assert.equal(status({ phase: "idle" }), "録音を始められます。");
  assert.equal(status({ phase: "connecting" }), "マイクと OpenAI に接続しています…");
  assert.match(status({ phase: "recording" }), /最大 120 秒で自動停止/);
  assert.equal(status({ phase: "finalizing", stopReason: "manual" }), "停止しました。確定したテキストを待っています…");
  assert.match(status({ phase: "finalizing", stopReason: "limit" }), /上限の 120 秒で自動停止しました/);
  assert.equal(status({ phase: "done" }), "確定しました。");
  assert.equal(status({ phase: "error" }), "録音は完了していません。");
});

test("失敗の分類はすべてラベルを持ち、残高不足だけを独立した分類にする", () => {
  const codes: VoiceInputFailureCode[] = [
    "microphone-denied",
    "microphone-unavailable",
    "connect-timeout",
    "connect-failed",
    "insufficient-credit",
    "audio-filter",
    "connection-closed",
    "realtime-error",
    "commit-empty",
    "finalize-timeout",
    "finalize-failed",
  ];
  for (const code of codes) assert.notEqual(voiceInputFailureLabel(code), "");
  assert.equal(voiceInputFailureLabel("insufficient-credit"), "残高不足");
  assert.equal(new Set(codes.map(voiceInputFailureLabel)).size, codes.length);
});

test("計測値は未計測を「—」にし、1 秒未満は ms、1 秒以上は秒で出す", () => {
  assert.equal(formatVoiceInputMs(null), "—");
  assert.equal(formatVoiceInputMs(0), "0 ms");
  assert.equal(formatVoiceInputMs(999), "999 ms");
  assert.equal(formatVoiceInputMs(1_234), "1.2 秒");
  assert.equal(formatVoiceInputSeconds(null), "—");
  assert.equal(formatVoiceInputSeconds(12.25), "12.3 秒");
});

const render = (props: Parameters<typeof VoiceInputPlayground>[0]): string =>
  renderToStaticMarkup(createElement(VoiceInputPlayground, props));

const baseProps = {
  model: "gpt-live-transcribe",
  disabledReason: undefined,
  frameDeadlineSupported: true,
  state: INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
  onStart: () => {},
  onStop: () => {},
  onCancel: () => {},
};

/** 面の操作はボタンだけなので、ラベルの一覧で「保存・履歴の操作が無い」ことを確かめる */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1] ?? "");
}

test("表示: 録音前は開始と閉じるだけで、課金・外部送信・保存しないことを面の上に出す", () => {
  const html = render(baseProps);
  assert.deepEqual(buttonLabels(html), ["閉じる", "録音を開始"]);
  assert.match(html, /話した音声は OpenAI（gpt-live-transcribe）へ送られ/);
  assert.match(html, /1 回の録音ごとに利用料がかかります/);
  assert.match(html, /音声も文字起こしも保存せず、履歴にも残しません/);
  assert.match(html, /確定テキスト（読取専用・保存しません）/);
  assert.match(html, /録音を始められます。/);
  assert.doesNotMatch(html, /上限を過ぎた音声の送信を止められません/);
});

test("表示: 開始できない理由があるときは開始を無効にし、理由を出す", () => {
  const html = render({ ...baseProps, disabledReason: "APIキーを登録すると録音を試せます。" });
  assert.match(html, /APIキーを登録すると録音を試せます。/);
  assert.match(html, /<button[^>]*disabled[^>]*>録音を開始<\/button>/);
});

test("表示: 録音中は途中テキストと停止・中止を出し、開始は押せない", () => {
  const html = render({
    ...baseProps,
    state: {
      ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
      phase: "recording",
      partial: "青い傘を",
    },
  });
  assert.deepEqual(buttonLabels(html), ["閉じる", "録音を開始", "停止して確定", "中止"]);
  assert.match(html, /青い傘を/);
  assert.match(html, /録音中です。話してください（最大 120 秒で自動停止します）。/);
  assert.match(html, /<button[^>]*disabled[^>]*>録音を開始<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>停止して確定/);
});

test("表示: 確定後は確定テキストを読取専用で出し、秒数と待ち時間を並べる", () => {
  const html = render({
    ...baseProps,
    state: {
      ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
      phase: "done",
      stopReason: "manual",
      transcript: "青い傘を持って。",
      recordedSeconds: 3,
      firstPartialMs: 850,
      stopToFinalMs: 1_200,
    },
  });
  assert.deepEqual(buttonLabels(html), ["閉じる", "もう一度録音"]);
  assert.match(html, /<textarea[^>]*readOnly[^>]*>青い傘を持って。<\/textarea>/);
  assert.match(html, /3\.0 秒/);
  assert.match(html, /850 ms/);
  assert.match(html, /1\.2 秒/);
  assert.match(html, /確定しました。/);
});

test("表示: 失敗は分類のラベルと文言を alert で出し、確定テキストは残さない", () => {
  const html = render({
    ...baseProps,
    state: {
      ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE,
      phase: "error",
      failure: { code: "commit-empty", message: "音声が短すぎて確定できませんでした。もう一度話してください。" },
    },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /音声が短すぎます/);
  assert.match(html, /音声が短すぎて確定できませんでした。/);
  assert.match(html, /録音は完了していません。/);
});

test("表示: 上限の強制を持たないブラウザだけ、既知の制限を出す", () => {
  const html = render({ ...baseProps, frameDeadlineSupported: false });
  assert.match(html, /上限を過ぎた音声の送信を止められません/);
  assert.match(html, /上限を超えて送られることがあります/);
});
