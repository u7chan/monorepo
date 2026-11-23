// Composer の録音 1 回分の制御（client/src/lib/voiceInput/composer.ts）。録音そのものは fake にし、
// 世代で遅延コールバックを捨てること・中断の経路・送信を止める phase を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createVoiceInputComposer,
  INITIAL_VOICE_INPUT_COMPOSER_STATE,
  voiceInputComposerBlockedReason,
  voiceInputComposerBusy,
  voiceInputComposerCanStop,
  voiceInputRemainingRatio,
  type VoiceInputComposerCallbacks,
  type VoiceInputComposerState,
} from "../src/lib/voiceInput/composer";
import type { VoiceInputCallbacks } from "../src/lib/voiceInput/session";

/** 録音 1 回分の fake。`start` は呼ばれた順にコールバックを溜める */
function composer() {
  const callbacks: VoiceInputCallbacks[] = [];
  const captures: { stops: number; cancels: number }[] = [];
  const states: VoiceInputComposerState[] = [];
  const finals: string[] = [];
  const cancels: number[] = [];
  let unloaded: (() => void) | null = null;
  let unsubscribes = 0;
  const controller = createVoiceInputComposer({
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
    subscribeUnload: (listener) => {
      unloaded = listener;
      return () => {
        unsubscribes += 1;
      };
    },
    onChange: (state) => states.push(state),
  });
  const handlers = (): VoiceInputComposerCallbacks => ({
    onPartial: () => {},
    onFinal: (text) => finals.push(text),
    onCancel: () => cancels.push(cancels.length + 1),
    onError: () => {},
  });
  return {
    controller,
    handlers,
    callbacks,
    captures,
    states,
    finals,
    cancels,
    latest: (): VoiceInputComposerState => states.at(-1) ?? INITIAL_VOICE_INPUT_COMPOSER_STATE,
    unload: () => unloaded?.(),
    unsubscribes: () => unsubscribes,
  };
}

test("開始すると接続中になり、確定で待機へ戻って確定テキストを渡す", () => {
  const run = composer();
  run.controller.start(run.handlers());
  assert.equal(run.latest().phase, "connecting", "マイクの許可待ちを接続中として扱う");

  run.callbacks[0].onRecording({ startedAt: 100, deadline: 200 });
  assert.deepEqual(run.latest(), { phase: "recording", startedAt: 100, deadline: 200 });
  assert.equal(voiceInputComposerCanStop(run.latest()), true);

  run.callbacks[0].onFinalizing({ reason: "manual", stoppedAt: 150 });
  assert.equal(run.latest().phase, "finalizing");
  assert.equal(voiceInputComposerCanStop(run.latest()), false, "確定待ちでは録音を止め直せない");

  run.callbacks[0].onFinal({ text: "こんにちは", audioSeconds: 1.5 });
  assert.equal(run.latest().phase, "idle");
  assert.deepEqual(run.finals, ["こんにちは"]);
  assert.equal(run.cancels.length, 0, "確定は取消として扱わない");
});

test("停止は録音中だけ capture へ渡す", () => {
  const run = composer();
  run.controller.start(run.handlers());
  run.controller.stop();
  assert.equal(run.captures[0].stops, 1, "止める要求は capture が録音中かを見て捨てる");

  run.callbacks[0].onRecording({ startedAt: 100, deadline: 200 });
  run.controller.stop();
  assert.equal(run.captures[0].stops, 2);
});

test("取消は capture を捨てて待機へ戻り、所有領域を戻す合図を出す", () => {
  const run = composer();
  run.controller.start(run.handlers());
  run.callbacks[0].onRecording({ startedAt: 100, deadline: 200 });
  run.controller.cancel();
  assert.equal(run.captures[0].cancels, 1);
  assert.equal(run.latest().phase, "idle");
  assert.equal(run.cancels.length, 1);
});

test("取消の後に届いたコールバックは状態も本文も変えない", () => {
  // What: pagehide や会話の切替で捨てた録音の確定テキストが、次の下書きへ混ざらない
  const run = composer();
  run.controller.start(run.handlers());
  run.callbacks[0].onRecording({ startedAt: 100, deadline: 200 });
  run.controller.cancel();
  run.callbacks[0].onFinal({ text: "まざらない", audioSeconds: null });
  assert.equal(run.latest().phase, "idle");
  assert.deepEqual(run.finals, []);
});

test("pagehide でも録音を捨てる", () => {
  const run = composer();
  run.controller.start(run.handlers());
  run.callbacks[0].onRecording({ startedAt: 100, deadline: 200 });
  run.unload();
  assert.equal(run.captures[0].cancels, 1);
  assert.equal(run.latest().phase, "idle");
  assert.equal(run.cancels.length, 1);
});

test("待機中に取消を呼んでも capture も合図も増えない", () => {
  const run = composer();
  run.controller.cancel();
  assert.equal(run.captures.length, 0);
  assert.equal(run.cancels.length, 0);
});

test("操作中にもう一度開始しても、2 本目の録音を始めない", () => {
  const run = composer();
  run.controller.start(run.handlers());
  run.controller.start(run.handlers());
  assert.equal(run.callbacks.length, 1);
});

test("アンマウントでは capture を閉じるが、所有領域を戻す合図は出さない", () => {
  // 画面が消えるので本文を戻す先が無い（unmount 後の state 更新を呼び出し側へ強いるだけになる）
  const run = composer();
  run.controller.start(run.handlers());
  run.callbacks[0].onRecording({ startedAt: 100, deadline: 200 });
  run.controller.dispose();
  assert.equal(run.captures[0].cancels, 1);
  assert.equal(run.cancels.length, 0);
  assert.equal(run.unsubscribes(), 1);
});

test("音声の操作中は送信経路を閉じる理由を返す", () => {
  // What: Enter / submit / 再実行 / 未送信の再送は、この理由が返る間は通さない
  const phaseBlocked = (phase: VoiceInputComposerState["phase"]): string | undefined =>
    voiceInputComposerBlockedReason({ phase, startedAt: null, deadline: null });
  assert.equal(phaseBlocked("idle"), undefined);
  assert.equal(phaseBlocked("connecting"), "音声の接続中");
  assert.equal(phaseBlocked("recording"), "録音中");
  assert.equal(phaseBlocked("finalizing"), "音声の確定待ち");
  assert.equal(voiceInputComposerBusy({ phase: "idle", startedAt: null, deadline: null }), false);
  assert.equal(voiceInputComposerBusy({ phase: "recording", startedAt: 0, deadline: 1 }), true);
});

test("残り時間の割合は録音の経過だけで減り、期限を過ぎたら 0 になる", () => {
  assert.equal(voiceInputRemainingRatio(1_000, 0, 0), 1);
  assert.equal(voiceInputRemainingRatio(1_000, 0, 500), 0.5);
  assert.equal(voiceInputRemainingRatio(1_000, 0, 1_200), 0);
  assert.equal(voiceInputRemainingRatio(null, null, 500), 0, "録音前は弧を描かない");
  assert.equal(voiceInputRemainingRatio(1_000, 1_000, 0), 0, "期限の無い録音で 0 除算しない");
});
