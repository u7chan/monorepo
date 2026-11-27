/**
 * 録音 1 回分の Realtime 文字起こしの状態機械。接続 → 録音 → 停止 → commit → 確定 を 1 つの phase で
 * 持ち、DOM に依存しない (マイク・peer・期限 worker は platform として注入する)。
 */

/** 録音の上限。手動停止でも 120 秒を超えて録音しない */
export const VOICE_INPUT_MAX_SECONDS = 120;

/** マイクの許可と offer / answer の往復の上限 */
const CONNECT_TIMEOUT_MS = 30_000;
/** マイクを止めてから commit を送るまでの待ち。音声と制御は別経路なので、末尾の音声を追い越しうる */
const AUDIO_DRAIN_MS = 250;
/** commit を送ってから確定テキストを受け取るまでの上限 */
const FINAL_TIMEOUT_MS = 15_000;

/**
 * 失敗の分類。表示の文言は画面側が持ち、ここは「どの種類か」だけを返す
 * （上流の分類 `code` は `insufficient_credit` だけを残高不足として分ける）。
 */
export type VoiceInputFailureCode =
  | "microphone-denied"
  | "microphone-unavailable"
  | "connect-timeout"
  | "connect-failed"
  | "insufficient-credit"
  | "audio-filter"
  | "connection-closed"
  | "realtime-error"
  | "commit-empty"
  | "finalize-timeout"
  | "finalize-failed";

export type VoiceInputFailure = {
  code: VoiceInputFailureCode;
  /** 何が起きたかの 1 行。画面は分類のラベルと並べて出す */
  message: string;
};

/** 停止の理由。`limit` は上限による自動停止で、確定の扱いは手動停止と同じ */
export type VoiceInputStopReason = "manual" | "limit";

export type VoiceInputCallbacks = {
  onConnecting: () => void;
  onRecording: (input: { startedAt: number; deadline: number }) => void;
  onPartial: (text: string) => void;
  onFinalizing: (input: { reason: VoiceInputStopReason; stoppedAt: number }) => void;
  onFinal: (input: { text: string; audioSeconds: number | null }) => void;
  onError: (failure: VoiceInputFailure) => void;
};

export type VoiceInputAudioDeadline = {
  /** addTrack が返した sender へ、期限でフレームを落とす仕組みを結び付ける */
  attach: (sender: RTCRtpSender) => void;
  /** 期限。`now()` と同じ基準の絶対時刻 */
  arm: (deadline: number) => void;
  close: () => void;
};

/** BFF の `POST /api/voice-input/session` の結果。`code` は上流の失敗分類 */
export type VoiceInputSessionAnswer = { ok: true; sdp: string } | { ok: false; code?: string; message: string };

/** 録音 1 回分がブラウザ・サーバーへ出す要求。テストは全て fake にする */
export type VoiceInputPlatform = {
  getMicrophone: () => Promise<MediaStream>;
  makePeer: () => RTCPeerConnection;
  /** 期限の強制を持てないブラウザでは、何もしない実装を返す（期限は画面側のタイマーだけになる） */
  makeAudioDeadline: (onError: () => void) => VoiceInputAudioDeadline;
  request: (offer: string, signal: AbortSignal) => Promise<VoiceInputSessionAnswer>;
  now: () => number;
};

export type VoiceInputCapture = {
  /** 録音中なら音声を止めて確定へ進む。録音前・確定後は何もしない */
  stop: () => void;
  /** 音声も文字起こしも捨てる。以後に届いたコールバックは呼ばない */
  cancel: () => void;
};

type VoiceInputOutcome = { text: string; audioSeconds: number | null };

type RealtimeEvent = {
  type?: unknown;
  item_id?: unknown;
  delta?: unknown;
  transcript?: unknown;
  usage?: unknown;
  error?: { code?: unknown };
};

/**
 * 録音を始める。成功・失敗のどちらでも、コールバックは次のどれか 1 つで終わる:
 * `onFinal`（確定）か `onError`（失敗）、`cancel()`（利用者の中断）。
 */
export function startTranscription(
  callbacks: VoiceInputCallbacks,
  { limitSeconds = VOICE_INPUT_MAX_SECONDS, platform }: { limitSeconds?: number; platform: VoiceInputPlatform },
): VoiceInputCapture {
  const limitMs = limitMilliseconds(limitSeconds);
  const abort = new AbortController();
  let phase: "connecting" | "recording" | "finalizing" | "closed" = "connecting";
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let audioDeadline: VoiceInputAudioDeadline | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previewItemId: string | undefined;
  let preview = "";
  let commitSent = false;
  let committedId: string | undefined;
  const outcomes = new Map<string, VoiceInputOutcome | null>();

  function schedule(ms: number, action: () => void): void {
    clearTimeout(timer);
    timer = setTimeout(action, ms);
  }

  function close(): void {
    if (phase === "closed") return;
    phase = "closed";
    clearTimeout(timer);
    abort.abort();
    stopStream(stream);
    stream = undefined;
    channel?.close();
    peer?.close();
    audioDeadline?.close();
  }

  /** 中止済みか。`close()` は必ず abort するので、遅れて届いた処理の判定に使う */
  function cancelled(): boolean {
    return abort.signal.aborted;
  }

  function fail(failure: VoiceInputFailure): void {
    if (phase === "closed") return;
    close();
    callbacks.onError(failure);
  }

  function stop(reason: VoiceInputStopReason = "manual"): void {
    if (phase !== "recording") return;
    phase = "finalizing";
    // 上限で止めた場合、画面が固まっていた分だけ手前で切れる。録音時間を上限側へ丸めない
    const stoppedAt = Math.min(platform.now(), deadline);
    stopStream(stream);
    stream = undefined;
    callbacks.onFinalizing({ reason, stoppedAt });
    // 音声と制御は別経路なので、停止と同時に commit すると末尾の音声を追い越しうる
    schedule(AUDIO_DRAIN_MS, () => {
      if (phase !== "finalizing") return;
      if (channel === undefined) {
        fail({ code: "finalize-failed", message: "録音の確定を要求できませんでした。" });
        return;
      }
      schedule(FINAL_TIMEOUT_MS, () =>
        fail({ code: "finalize-timeout", message: "確定テキストを受け取る前にタイムアウトしました。" }),
      );
      commitSent = true;
      try {
        channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        fail({ code: "finalize-failed", message: "録音の確定を要求できませんでした。" });
      }
    });
  }

  function receive(data: unknown): void {
    if (phase === "closed") return;
    const event = parseRealtimeEvent(data);
    if (event === null) return;
    if (event.type === "error") {
      fail(
        event.error?.code === "input_audio_buffer_commit_empty"
          ? { code: "commit-empty", message: "音声が短すぎて確定できませんでした。もう一度話してください。" }
          : { code: "realtime-error", message: "OpenAI の Realtime セッションでエラーが発生しました。" },
      );
      return;
    }
    const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      if (phase === "recording" && itemId !== undefined && typeof event.delta === "string") {
        previewItemId ??= itemId;
        if (previewItemId === itemId) {
          preview += event.delta;
          if (preview.trim()) callbacks.onPartial(preview);
        }
      }
      return;
    }
    if (!commitSent || itemId === undefined) return;
    if (event.type === "input_audio_buffer.committed") {
      committedId ??= itemId;
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = typeof event.transcript === "string" ? event.transcript : "";
      outcomes.set(itemId, { text, audioSeconds: audioDurationSeconds(event.usage) });
    } else if (event.type === "conversation.item.input_audio_transcription.failed") {
      outcomes.set(itemId, null);
    }
    // 確定イベントが commit の確認より先に届いても落とさない
    if (committedId === undefined || !outcomes.has(committedId)) return;
    const outcome = outcomes.get(committedId);
    if (!outcome?.text.trim()) {
      fail({ code: "finalize-failed", message: "有効な確定テキストを受け取れませんでした。" });
      return;
    }
    close();
    callbacks.onFinal(outcome);
  }

  async function connect(): Promise<void> {
    let microphone: MediaStream;
    try {
      microphone = await platform.getMicrophone();
    } catch (error) {
      // 中止後に届いた失敗で、利用者のキャンセルを失敗として上書きしない
      if (cancelled()) return;
      fail(
        error instanceof Error && error.name === "NotAllowedError"
          ? { code: "microphone-denied", message: "ブラウザでマイクの利用を許可してください。" }
          : { code: "microphone-unavailable", message: "マイクを利用できませんでした。" },
      );
      return;
    }
    // 許可を待っている間に中止された場合、後から得たマイクも解放する
    if (cancelled()) {
      stopStream(microphone);
      return;
    }
    stream = microphone;
    callbacks.onConnecting();
    try {
      await negotiate(microphone);
    } catch {
      if (cancelled()) return;
      fail({ code: "connect-failed", message: "WebRTC 接続を開始できませんでした。" });
    }
  }

  async function negotiate(microphone: MediaStream): Promise<void> {
    const connection = platform.makePeer();
    peer = connection;
    const audio = platform.makeAudioDeadline(() => {
      if (phase === "connecting" || phase === "recording") {
        fail({ code: "audio-filter", message: "音声の送信を制御できませんでした。" });
      }
    });
    audioDeadline = audio;
    const tracks = microphone.getAudioTracks();
    for (const track of tracks) {
      track.enabled = false;
      track.addEventListener("ended", () => {
        if (phase === "connecting" || phase === "recording") {
          fail({ code: "connection-closed", message: "マイクの接続が切れました。" });
        }
      });
      audio.attach(connection.addTrack(track, microphone));
    }
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        fail({ code: "connection-closed", message: "WebRTC の接続が切れました。" });
      }
    });
    const data = connection.createDataChannel("oai-events");
    channel = data;
    data.addEventListener("open", () => {
      if (phase !== "connecting") return;
      const startedAt = platform.now();
      deadline = startedAt + limitMs;
      audio.arm(deadline);
      for (const track of tracks) track.enabled = true;
      phase = "recording";
      schedule(limitMs, () => stop("limit"));
      callbacks.onRecording({ startedAt, deadline });
    });
    data.addEventListener("message", (event: MessageEvent) => receive(event.data));
    data.addEventListener("close", () =>
      fail({ code: "connection-closed", message: "確定前に OpenAI との接続が閉じました。" }),
    );
    data.addEventListener("error", () =>
      fail({ code: "connection-closed", message: "OpenAI とのデータ通信でエラーが発生しました。" }),
    );

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const answer = await platform.request(connection.localDescription?.sdp ?? offer.sdp ?? "", abort.signal);
    if (cancelled()) return;
    if (!answer.ok) {
      fail({
        code: answer.code === "insufficient_credit" ? "insufficient-credit" : "connect-failed",
        message: answer.message,
      });
      return;
    }
    await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  }

  schedule(CONNECT_TIMEOUT_MS, () =>
    fail({ code: "connect-timeout", message: "マイクの許可または WebRTC 接続がタイムアウトしました。" }),
  );
  void connect();
  return { stop: () => stop(), cancel: () => close() };
}

/** 呼び出し側の指定で上限を超えない（超えた録音は、期限の強制と画面の表示がずれる） */
function limitMilliseconds(limitSeconds: number): number {
  if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) return VOICE_INPUT_MAX_SECONDS * 1000;
  return Math.min(limitSeconds, VOICE_INPUT_MAX_SECONDS) * 1000;
}

function stopStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as RealtimeEvent) : null;
  } catch {
    return null;
  }
}

function audioDurationSeconds(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const { type, seconds } = usage as { type?: unknown; seconds?: unknown };
  return type === "duration" && typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : null;
}
