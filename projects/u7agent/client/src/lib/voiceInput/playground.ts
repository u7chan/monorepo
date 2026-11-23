/**
 * 設定 → 音声入力のプレイグラウンドの state と操作。録音 1 回分の表示（途中・確定・秒数・失敗の分類）だけを持ち、
 * 保存も履歴も持たない。DOM に依存させず、`client/src/hooks/useVoiceInputPlayground.ts` から切り離してテストする。
 * 録音そのものは `./session.ts` の状態機械が持ち、ここは世代を進めて遅延コールバックを捨てる。
 */
import {
  VOICE_INPUT_MAX_SECONDS,
  type VoiceInputCallbacks,
  type VoiceInputCapture,
  type VoiceInputFailure,
  type VoiceInputFailureCode,
  type VoiceInputStopReason,
} from "./session";

export type VoiceInputPlaygroundPhase = "idle" | "connecting" | "recording" | "finalizing" | "done" | "error";

export type VoiceInputPlaygroundState = {
  phase: VoiceInputPlaygroundPhase;
  /** 停止の理由。録音前・確定後は null */
  stopReason: VoiceInputStopReason | null;
  /** 途中テキスト。確定したら空へ戻す（確定テキストと混ぜない） */
  partial: string;
  /** 確定テキスト。読取専用で出し、次の録音を始めるまで残す */
  transcript: string;
  /** 録音の開始から停止までの秒数。停止前は null */
  recordedSeconds: number | null;
  /** 録音の開始から最初の途中表示までの ms。途中表示が出なければ null */
  firstPartialMs: number | null;
  /** 停止から確定までの ms。未確定は null */
  stopToFinalMs: number | null;
  /** 最後の失敗。開始・確定で消す */
  failure: VoiceInputFailure | null;
};

export const INITIAL_VOICE_INPUT_PLAYGROUND_STATE: VoiceInputPlaygroundState = {
  phase: "idle",
  stopReason: null,
  partial: "",
  transcript: "",
  recordedSeconds: null,
  firstPartialMs: null,
  stopToFinalMs: null,
  failure: null,
};

export type VoiceInputPlaygroundOptions = {
  /** 録音 1 回分を始める。ブラウザでは `startTranscription` を platform 固定で呼ぶ */
  start: (callbacks: VoiceInputCallbacks) => VoiceInputCapture;
  now: () => number;
  /** 画面を離れる通知（`pagehide`）を購読する。返り値で解除する */
  subscribeUnload: (listener: () => void) => () => void;
  onChange: (state: VoiceInputPlaygroundState) => void;
};

export type VoiceInputPlaygroundController = {
  start: () => void;
  stop: () => void;
  cancel: () => void;
  dispose: () => void;
};

/**
 * 1 面ぶんの録音を操作する。終了の導線（手動停止 / 自動停止 / キャンセル / 面を閉じる / 設定を離れる /
 * `pagehide`）は、すべて `stop()` か `cancel()` か `dispose()` のどれかに集める。
 */
export function createVoiceInputPlayground({
  start,
  now,
  subscribeUnload,
  onChange,
}: VoiceInputPlaygroundOptions): VoiceInputPlaygroundController {
  let state = INITIAL_VOICE_INPUT_PLAYGROUND_STATE;
  /** 録音の世代。古い capture から遅れて届いたコールバックは状態を変えない */
  let generation = 0;
  let capture: VoiceInputCapture | null = null;
  let startedAt: number | null = null;
  let stoppedAt: number | null = null;

  const update = (patch: Partial<VoiceInputPlaygroundState>): void => {
    state = { ...state, ...patch };
    onChange(state);
  };

  const live = (): boolean =>
    state.phase === "connecting" || state.phase === "recording" || state.phase === "finalizing";

  const cancel = (): void => {
    generation += 1;
    const running = capture;
    capture = null;
    running?.cancel();
    if (live()) update({ ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE });
  };

  const runStart = (): void => {
    if (live()) return;
    const current = ++generation;
    startedAt = null;
    stoppedAt = null;
    update({ ...INITIAL_VOICE_INPUT_PLAYGROUND_STATE, phase: "connecting" });
    const accept = (action: () => void): void => {
      if (current === generation) action();
    };
    capture = start({
      onConnecting: () => accept(() => update({ phase: "connecting" })),
      onRecording: ({ startedAt: at }) =>
        accept(() => {
          startedAt = at;
          update({ phase: "recording" });
        }),
      onPartial: (text) =>
        accept(() => {
          const first = state.firstPartialMs ?? (startedAt === null ? null : now() - startedAt);
          update({ partial: text, firstPartialMs: first });
        }),
      onFinalizing: ({ reason, stoppedAt: at }) =>
        accept(() => {
          stoppedAt = at;
          update({
            phase: "finalizing",
            stopReason: reason,
            partial: "",
            recordedSeconds: startedAt === null ? null : (at - startedAt) / 1000,
          });
        }),
      onFinal: ({ text }) =>
        accept(() =>
          update({
            phase: "done",
            partial: "",
            transcript: text,
            stopToFinalMs: stoppedAt === null ? null : now() - stoppedAt,
          }),
        ),
      onError: (failure) => accept(() => update({ phase: "error", partial: "", failure })),
    });
  };

  const unsubscribe = subscribeUnload(cancel);
  return {
    start: runStart,
    stop: () => capture?.stop(),
    cancel,
    dispose: () => {
      unsubscribe();
      cancel();
    },
  };
}

/** 録音の開始・停止のどちらも受け付けない間か（ボタンの disabled に使う） */
export function voiceInputPlaygroundBusy(state: VoiceInputPlaygroundState): boolean {
  return state.phase === "connecting" || state.phase === "recording" || state.phase === "finalizing";
}

/** 停止を受け付ける間か（停止は録音中だけ。接続中はキャンセルになる） */
export function voiceInputPlaygroundCanStop(state: VoiceInputPlaygroundState): boolean {
  return state.phase === "recording";
}

/** いま何をしているかの 1 行。上限の秒数は録音の上限（`session.ts`）と同じ値を使う */
export function voiceInputPlaygroundStatus(state: VoiceInputPlaygroundState): string {
  switch (state.phase) {
    case "idle":
      return "録音を始められます。";
    case "connecting":
      return "マイクと OpenAI に接続しています…";
    case "recording":
      return `録音中です。話してください（最大 ${VOICE_INPUT_MAX_SECONDS} 秒で自動停止します）。`;
    case "finalizing":
      return state.stopReason === "limit"
        ? `上限の ${VOICE_INPUT_MAX_SECONDS} 秒で自動停止しました。確定したテキストを待っています…`
        : "停止しました。確定したテキストを待っています…";
    case "done":
      return "確定しました。";
    case "error":
      return "録音は完了していません。";
  }
}

const FAILURE_LABELS: Record<VoiceInputFailureCode, string> = {
  "microphone-denied": "マイクが許可されていません",
  "microphone-unavailable": "マイクを利用できません",
  "connect-timeout": "接続がタイムアウト",
  "connect-failed": "接続を開始できません",
  "insufficient-credit": "残高不足",
  "audio-filter": "音声の送信を制御できません",
  "connection-closed": "接続が切れました",
  "realtime-error": "文字起こしのエラー",
  "commit-empty": "音声が短すぎます",
  "finalize-timeout": "確定がタイムアウト",
  "finalize-failed": "確定できませんでした",
};

/** 失敗の分類のラベル。文言は `session.ts` が返す 1 行と並べて出し、分類だけをここで持つ */
export function voiceInputFailureLabel(code: VoiceInputFailureCode): string {
  return FAILURE_LABELS[code];
}

/** 計測値の表示。未計測は `—` にして、0 ms と計測できなかった場合を混同しない */
export function formatVoiceInputMs(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} 秒`;
}

export function formatVoiceInputSeconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} 秒`;
}
