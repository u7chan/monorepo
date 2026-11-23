/**
 * Composer の録音 1 回分の状態機械。`./playground.ts` と同じく、録音に世代を持たせて遅れて届いた
 * コールバックを捨てる。所有領域（`./draft.ts`）の書き換えは本文を持つ呼び出し側に任せ、
 * ここは「どの phase か」と「中断・確定・失敗のどれで終わったか」だけを返す。
 */
import type { VoiceInputCallbacks, VoiceInputCapture, VoiceInputFailure } from "./session";

/** 待機（`idle`）以外は、送信経路と主ボタンを音声の操作が占有する */
export type VoiceInputComposerPhase = "idle" | "connecting" | "recording" | "finalizing";

export type VoiceInputComposerState = {
  phase: VoiceInputComposerPhase;
  /** 録音の開始時刻。録音前は null */
  startedAt: number | null;
  /** 録音の期限（残り時間の弧の根拠）。録音前は null */
  deadline: number | null;
};

export const INITIAL_VOICE_INPUT_COMPOSER_STATE: VoiceInputComposerState = {
  phase: "idle",
  startedAt: null,
  deadline: null,
};

export type VoiceInputComposerCallbacks = {
  /** 途中の文字起こし。所有領域を差し替える */
  onPartial: (text: string) => void;
  /** 確定テキスト。所有領域を差し替える（所有を失っていれば呼び出し側が捨てる） */
  onFinal: (text: string) => void;
  /** 利用者の取消 / 画面移動 / pagehide / アンマウント。所有領域を開始前へ戻す */
  onCancel: () => void;
  onError: (failure: VoiceInputFailure) => void;
};

export type VoiceInputComposerOptions = {
  start: (callbacks: VoiceInputCallbacks) => VoiceInputCapture;
  subscribeUnload: (listener: () => void) => () => void;
  onChange: (state: VoiceInputComposerState) => void;
};

export type VoiceInputComposerController = {
  start: (callbacks: VoiceInputComposerCallbacks) => void;
  /** 録音中だけ止めて確定へ進む。接続中・確定後は何もしない */
  stop: () => void;
  /** 音声も文字起こしも捨てる。所有領域を戻す合図 (`onCancel`) を呼ぶ */
  cancel: () => void;
  dispose: () => void;
};

/**
 * 録音の入口を 1 つに畳む。中断の経路（取消ボタン / 別の画面へ移る / 会話の切替 / `pagehide` /
 * アンマウント）はすべて `cancel()` を通す。
 */
export function createVoiceInputComposer({
  start,
  subscribeUnload,
  onChange,
}: VoiceInputComposerOptions): VoiceInputComposerController {
  let state = INITIAL_VOICE_INPUT_COMPOSER_STATE;
  /** 録音の世代。古い capture から遅れて届いたコールバックは状態も本文も変えない */
  let generation = 0;
  let capture: VoiceInputCapture | null = null;
  let callbacks: VoiceInputComposerCallbacks | null = null;

  const update = (patch: Partial<VoiceInputComposerState>): void => {
    state = { ...state, ...patch };
    onChange(state);
  };

  const cancel = (): void => {
    if (state.phase === "idle") return;
    generation += 1;
    const running = capture;
    const pending = callbacks;
    capture = null;
    callbacks = null;
    running?.cancel();
    update({ ...INITIAL_VOICE_INPUT_COMPOSER_STATE });
    pending?.onCancel();
  };

  const runStart = (next: VoiceInputComposerCallbacks): void => {
    if (state.phase !== "idle") return;
    const current = ++generation;
    callbacks = next;
    update({ ...INITIAL_VOICE_INPUT_COMPOSER_STATE, phase: "connecting" });
    const accept = (action: () => void): void => {
      if (current === generation) action();
    };
    const settle = (): void => {
      capture = null;
      callbacks = null;
      update({ ...INITIAL_VOICE_INPUT_COMPOSER_STATE });
    };
    capture = start({
      onConnecting: () => accept(() => update({ phase: "connecting" })),
      onRecording: ({ startedAt, deadline }) => accept(() => update({ phase: "recording", startedAt, deadline })),
      onPartial: (text) => accept(() => next.onPartial(text)),
      onFinalizing: () => accept(() => update({ phase: "finalizing", startedAt: null, deadline: null })),
      onFinal: ({ text }) =>
        accept(() => {
          settle();
          next.onFinal(text);
        }),
      onError: (failure) =>
        accept(() => {
          settle();
          next.onError(failure);
        }),
    });
  };

  const unsubscribe = subscribeUnload(cancel);
  return {
    start: runStart,
    stop: () => capture?.stop(),
    cancel,
    dispose: () => {
      unsubscribe();
      // 画面ごと消えるので所有領域を戻す合図は出さない（unmount 後に呼び出し側の state 更新を走らせない）
      generation += 1;
      const running = capture;
      capture = null;
      callbacks = null;
      running?.cancel();
    },
  };
}

/** 音声の操作が入力欄の主スロットと送信経路を占有している間か */
export function voiceInputComposerBusy(state: VoiceInputComposerState): boolean {
  return state.phase !== "idle";
}

/** 録音を止められる間か（接続中は確定へ進めない。取消だけを受け付ける） */
export function voiceInputComposerCanStop(state: VoiceInputComposerState): boolean {
  return state.phase === "recording";
}

/**
 * 録音の残り時間の割合（1 → 0）。弧の角度はここだけで決め、描画は受け取った値をそのまま使う。
 * 期限が無い・過ぎている場合は 0 にし、時計の逆行で弧が増えないようにする。
 */
export function voiceInputRemainingRatio(deadline: number | null, startedAt: number | null, now: number): number {
  if (deadline === null || startedAt === null || deadline <= startedAt) return 0;
  const remaining = (deadline - now) / (deadline - startedAt);
  return Math.min(Math.max(remaining, 0), 1);
}

/**
 * 送信できない理由。録音の途中で本文を送ると、確定テキストの入る先の会話が変わる。
 * 文言は再実行の押せない理由（`client/src/lib/runRetry.ts`）と並べても読める長さにする。
 */
export function voiceInputComposerBlockedReason(state: VoiceInputComposerState): string | undefined {
  switch (state.phase) {
    case "idle":
      return undefined;
    case "connecting":
      return "音声の接続中";
    case "recording":
      return "録音中";
    case "finalizing":
      return "音声の確定待ち";
  }
}
