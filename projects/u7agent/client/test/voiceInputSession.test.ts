// 録音 1 回分の状態機械（client/src/lib/voiceInput/session.ts）。実マイク・実 peer・実 Worker・実 API は作らず、
// platform（マイク / peer / 期限の強制 / BFF への要求 / 時計）を fake にして、遷移・順序・分類だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  startTranscription,
  VOICE_INPUT_MAX_SECONDS,
  type VoiceInputAudioDeadline,
  type VoiceInputFailure,
  type VoiceInputPlatform,
  type VoiceInputSessionAnswer,
  type VoiceInputStopReason,
} from "../src/lib/voiceInput/session";

const eventPrefix = "conversation.item.input_audio_transcription.";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 1 回分の fake。実 API を呼ばず、イベントは `receive` で流し込む */
function fixture({
  limitSeconds,
  answer = { ok: true, sdp: "answer-sdp" },
  microphone,
  noAudioDeadline = false,
}: {
  limitSeconds?: number;
  answer?: VoiceInputSessionAnswer | Promise<VoiceInputSessionAnswer>;
  /** マイクの取得。省略は即座に成功する */
  microphone?: () => Promise<MediaStream>;
  /** 期限の強制を持たないブラウザの代わり（worker 無し） */
  noAudioDeadline?: boolean;
} = {}) {
  const clock = { value: 1_000 };
  const partials: string[] = [];
  const finalizing: { reason: VoiceInputStopReason; stoppedAt: number }[] = [];
  const errors: VoiceInputFailure[] = [];
  const offers: string[] = [];
  const armed: number[] = [];
  const attached: unknown[] = [];
  const recording = deferred<{ startedAt: number; deadline: number }>();
  const commit = deferred<string>();
  const final = deferred<{ text: string; audioSeconds: number | null }>();
  const failure = deferred<VoiceInputFailure>();
  const requestIssued = deferred<void>();
  const counts = { trackStops: 0, peerClosed: 0, deadlineClosed: 0, channelClosed: 0, peers: 0, commits: 0 };

  const track = Object.assign(new EventTarget(), {
    enabled: true,
    stop: () => {
      counts.trackStops += 1;
    },
  });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const channel = Object.assign(new EventTarget(), {
    close: () => {
      counts.channelClosed += 1;
    },
    send: (message: string) => {
      counts.commits += 1;
      commit.resolve(message);
    },
  });
  const peer = Object.assign(new EventTarget(), {
    addTrack: (_track: MediaStreamTrack, _stream: MediaStream) => {
      const sender = { transform: undefined };
      attached.push(sender);
      return sender;
    },
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "offer-sdp" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {
      channel.dispatchEvent(new Event("open"));
    },
    close: () => {
      counts.peerClosed += 1;
    },
    connectionState: "new",
  });
  let deadlineError: (() => void) | undefined;
  const audioDeadline: VoiceInputAudioDeadline = noAudioDeadline
    ? { attach: () => {}, arm: () => {}, close: () => {} }
    : {
        attach: () => {},
        arm: (deadline) => {
          armed.push(deadline);
        },
        close: () => {
          counts.deadlineClosed += 1;
        },
      };
  const platform: VoiceInputPlatform = {
    getMicrophone: microphone ?? (() => Promise.resolve(stream)),
    makePeer: () => {
      counts.peers += 1;
      return peer as unknown as RTCPeerConnection;
    },
    makeAudioDeadline: (onError) => {
      deadlineError = onError;
      return audioDeadline;
    },
    request: async (offer) => {
      offers.push(offer);
      requestIssued.resolve();
      return answer;
    },
    now: () => clock.value,
  };
  const capture = startTranscription(
    {
      onConnecting: () => {},
      onRecording: (input) => recording.resolve(input),
      onPartial: (text) => partials.push(text),
      onFinalizing: (input) => finalizing.push(input),
      onFinal: (input) => final.resolve(input),
      onError: (error) => {
        errors.push(error);
        failure.resolve(error);
      },
    },
    { ...(limitSeconds === undefined ? {} : { limitSeconds }), platform },
  );

  return {
    capture,
    clock,
    partials,
    finalizing,
    errors,
    offers,
    armed,
    attached,
    counts,
    track,
    channel,
    recording: recording.promise,
    commit: commit.promise,
    final: final.promise,
    failure: failure.promise,
    requestIssued: requestIssued.promise,
    /** 確定と失敗のどちらか先に起きたほう。待ちっぱなしで固まらないようにする */
    settled: () =>
      Promise.race([
        final.promise.then((value) => ({ ok: true as const, value })),
        failure.promise.then((value) => ({ ok: false as const, value })),
      ]),
    /** 期限の強制（worker）からの失敗通知 */
    failAudioDeadline: () => deadlineError?.(),
    stopReasonOf: () => finalizing.at(-1)?.reason,
    receive: (event: unknown) => channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
  };
}

type Fixture = ReturnType<typeof fixture>;

function sendCommitted(f: Fixture, itemId = "turn") {
  f.receive({ type: "input_audio_buffer.committed", item_id: itemId });
}

function sendCompleted(f: Fixture, itemId = "turn", transcript = "青い傘を持って。", usage?: unknown) {
  f.receive({
    type: `${eventPrefix}completed`,
    item_id: itemId,
    transcript,
    ...(usage === undefined ? {} : { usage }),
  });
}

/** 停止 → 音声の drain 待ち → commit までを進める。停止と同時には commit しない */
async function stopAndCommit(f: Fixture, tick: (ms: number) => void) {
  f.capture.stop();
  assert.equal(f.counts.commits, 0);
  tick(250);
  assert.equal(f.counts.commits, 1);
  return await f.commit;
}

test("接続して録音を始め、停止後は commit した発話の確定テキストと音声秒数だけを採用する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    const { startedAt, deadline } = await f.recording;
    assert.equal(startedAt, 1_000);
    assert.equal(deadline, startedAt + VOICE_INPUT_MAX_SECONDS * 1000);
    assert.deepEqual(f.armed, [deadline]);
    assert.equal(f.track.enabled, true);
    assert.equal(f.counts.peers, 1);
    assert.deepEqual(f.offers, ["offer-sdp"]);
    assert.equal(f.attached.length, 1);

    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "青い" });
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "傘" });
    assert.deepEqual(f.partials, ["青い", "青い傘"]);

    f.clock.value = 4_000;
    assert.equal(
      await stopAndCommit(f, (ms) => t.mock.timers.tick(ms)),
      JSON.stringify({ type: "input_audio_buffer.commit" }),
    );
    assert.deepEqual(f.finalizing, [{ reason: "manual", stoppedAt: 4_000 }]);
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 0);

    // 停止後に届いた途中テキストは、確定テキストと混ぜない
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "を持って" });
    assert.deepEqual(f.partials, ["青い", "青い傘"]);

    // 確定イベントが commit の確認より先に届いても落とさない。別の発話は採用しない
    sendCompleted(f, "other", "別の発話", { type: "duration", seconds: 43 });
    sendCompleted(f, "turn", "青い傘を持って。", { type: "duration", seconds: 12.25 });
    assert.equal(f.counts.peerClosed, 0);
    sendCommitted(f, "turn");
    assert.deepEqual(await f.settled(), { ok: true, value: { text: "青い傘を持って。", audioSeconds: 12.25 } });
    assert.equal(f.counts.peerClosed, 1);
    assert.equal(f.counts.deadlineClosed, 1);
    assert.equal(f.counts.channelClosed, 1);
  } finally {
    f.capture.cancel();
  }
});

test("停止から commit までは音声の drain を待ち、確定前に delta が無くても確定は受け取る", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    assert.equal(
      await stopAndCommit(f, (ms) => t.mock.timers.tick(ms)),
      JSON.stringify({ type: "input_audio_buffer.commit" }),
    );
    sendCommitted(f);
    sendCompleted(f);
    assert.deepEqual(await f.settled(), { ok: true, value: { text: "青い傘を持って。", audioSeconds: null } });
    assert.deepEqual(f.partials, []);
  } finally {
    f.capture.cancel();
  }
});

test("音声秒数は duration の有限な非負の数だけを採用する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cases: { usage: unknown; audioSeconds: number | null }[] = [
    { usage: { type: "tokens", seconds: 12 }, audioSeconds: null },
    { usage: { type: "duration", seconds: "12" }, audioSeconds: null },
    { usage: { type: "duration", seconds: -1 }, audioSeconds: null },
    { usage: { type: "duration", seconds: Number.NaN }, audioSeconds: null },
    { usage: { type: "duration", seconds: 0 }, audioSeconds: 0 },
    { usage: undefined, audioSeconds: null },
  ];
  for (const { usage, audioSeconds } of cases) {
    const f = fixture();
    try {
      await f.recording;
      await stopAndCommit(f, (ms) => t.mock.timers.tick(ms));
      sendCommitted(f);
      sendCompleted(f, "turn", "青い傘。", usage);
      assert.deepEqual(await f.settled(), { ok: true, value: { text: "青い傘。", audioSeconds } });
    } finally {
      f.capture.cancel();
    }
  }
});

test("上限の 120 秒で自動停止し、手動停止と同じ手順で確定する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    const { deadline } = await f.recording;
    t.mock.timers.tick(VOICE_INPUT_MAX_SECONDS * 1000 - 1);
    assert.equal(f.counts.trackStops, 0);
    assert.deepEqual(f.finalizing, []);
    f.clock.value = deadline;
    t.mock.timers.tick(1);
    assert.equal(f.counts.trackStops, 1);
    assert.deepEqual(f.finalizing, [{ reason: "limit", stoppedAt: deadline }]);
    t.mock.timers.tick(250);
    assert.equal(await f.commit, JSON.stringify({ type: "input_audio_buffer.commit" }));
    sendCommitted(f);
    sendCompleted(f, "turn", "青い傘。");
    assert.deepEqual(await f.settled(), { ok: true, value: { text: "青い傘。", audioSeconds: null } });
  } finally {
    f.capture.cancel();
  }
});

test("上限の指定が 120 秒を超えても、120 秒で録音を止める", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ limitSeconds: 600 });
  try {
    const { startedAt, deadline } = await f.recording;
    assert.equal(deadline - startedAt, VOICE_INPUT_MAX_SECONDS * 1000);
  } finally {
    f.capture.cancel();
  }
});

test("音声が短すぎる commit は commit-empty として中止し、マイクと接続を閉じる", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    await stopAndCommit(f, (ms) => t.mock.timers.tick(ms));
    f.receive({ type: "error", error: { code: "input_audio_buffer_commit_empty" } });
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: {
        code: "commit-empty",
        message: "音声が短すぎて確定できませんでした。もう一度話してください。",
      },
    });
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 1);
  } finally {
    f.capture.cancel();
  }
});

test("Realtime のその他のエラーは realtime-error として中止する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    f.receive({ type: "error", error: { code: "invalid_value" } });
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: {
        code: "realtime-error",
        message: "OpenAI の Realtime セッションでエラーが発生しました。",
      },
    });
  } finally {
    f.capture.cancel();
  }
});

test("確定テキストを受け取る前にタイムアウトしたら finalize-timeout として中止する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    await stopAndCommit(f, (ms) => t.mock.timers.tick(ms));
    t.mock.timers.tick(15_000);
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: {
        code: "finalize-timeout",
        message: "確定テキストを受け取る前にタイムアウトしました。",
      },
    });
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 1);
  } finally {
    f.capture.cancel();
  }
});

test("録音中に接続が切れたら connection-closed として中止し、マイクを解放する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    f.channel.dispatchEvent(new Event("close"));
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: { code: "connection-closed", message: "確定前に OpenAI との接続が閉じました。" },
    });
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 1);
    assert.deepEqual(f.finalizing, []);
  } finally {
    f.capture.cancel();
  }
});

test("マイクが拒否されたら microphone-denied として、接続も要求もしない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({
    microphone: () => {
      const error = new Error("denied");
      error.name = "NotAllowedError";
      return Promise.reject(error);
    },
  });
  try {
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: { code: "microphone-denied", message: "ブラウザでマイクの利用を許可してください。" },
    });
    assert.equal(f.counts.peers, 0);
    assert.deepEqual(f.offers, []);
  } finally {
    f.capture.cancel();
  }
});

test("マイクを利用できないときは microphone-unavailable にする", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ microphone: () => Promise.reject(new Error("NotFoundError")) });
  try {
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: { code: "microphone-unavailable", message: "マイクを利用できませんでした。" },
    });
  } finally {
    f.capture.cancel();
  }
});

test("BFF が返した失敗は connect-failed にまとめ、文言はサーバーのものをそのまま出す", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({
    answer: { ok: false, code: "rate_limited", message: "OpenAI が混雑しています。時間をおいて再試行してください" },
  });
  try {
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: { code: "connect-failed", message: "OpenAI が混雑しています。時間をおいて再試行してください" },
    });
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 1);
  } finally {
    f.capture.cancel();
  }
});

test("残高不足（insufficient_credit）だけを insufficient-credit として分ける", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({
    answer: {
      ok: false,
      code: "insufficient_credit",
      message: "OpenAI の残高が不足しています。Platform の利用状況を確認してください",
    },
  });
  try {
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: {
        code: "insufficient-credit",
        message: "OpenAI の残高が不足しています。Platform の利用状況を確認してください",
      },
    });
  } finally {
    f.capture.cancel();
  }
});

test("期限の強制（worker）の起動に失敗したら audio-filter として録音を中止する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    f.failAudioDeadline();
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: { code: "audio-filter", message: "音声の送信を制御できませんでした。" },
    });
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 1);
    assert.equal(f.counts.deadlineClosed, 1);
  } finally {
    f.capture.cancel();
  }
});

test("マイクの許可待ちでタイムアウトし、後から得たマイクも解放する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const permission = deferred<MediaStream>();
  const f = fixture({ microphone: () => permission.promise });
  try {
    t.mock.timers.tick(30_000);
    assert.deepEqual(await f.settled(), {
      ok: false,
      value: { code: "connect-timeout", message: "マイクの許可または WebRTC 接続がタイムアウトしました。" },
    });
    assert.equal(f.counts.peers, 0);
  } finally {
    f.capture.cancel();
  }
});

test("録音中にキャンセルすると、track / peer / worker / タイマーを閉じてコールバックを呼ばない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.recording;
    f.capture.cancel();
    assert.equal(f.counts.trackStops, 1);
    assert.equal(f.counts.peerClosed, 1);
    assert.equal(f.counts.deadlineClosed, 1);
    assert.equal(f.counts.channelClosed, 1);
    // タイマーが残っていれば自動停止や確定が走る。何も起きないことで解除を確かめる
    t.mock.timers.tick(VOICE_INPUT_MAX_SECONDS * 1000 + 60_000);
    assert.deepEqual(f.finalizing, []);
    assert.deepEqual(f.errors, []);
    assert.equal(f.counts.trackStops, 1);
  } finally {
    f.capture.cancel();
  }
});

test("マイクの許可待ちでキャンセルした場合、後から得たマイクを解放し peer を作らない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const permission = deferred<MediaStream>();
  let stops = 0;
  const track = Object.assign(new EventTarget(), {
    enabled: true,
    stop: () => {
      stops += 1;
    },
  });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const f = fixture({ microphone: () => permission.promise });
  try {
    f.capture.cancel();
    permission.resolve(stream);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(stops, 1);
    assert.equal(f.counts.peers, 0);
    assert.deepEqual(f.offers, []);
  } finally {
    f.capture.cancel();
  }
});

test("BFF の応答を待っている間にキャンセルしたら、遅れて届いた answer を採用しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = deferred<VoiceInputSessionAnswer>();
  const f = fixture({ answer: answer.promise });
  try {
    await f.requestIssued;
    f.capture.cancel();
    answer.resolve({ ok: true, sdp: "answer-sdp" });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.finalizing, []);
    assert.equal(f.counts.peerClosed, 1);
    assert.equal(f.counts.trackStops, 1);
  } finally {
    f.capture.cancel();
  }
});

test("期限の強制を持たない platform でも、上限のタイマーでマイクを止めて確定できる", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ noAudioDeadline: true });
  try {
    const { deadline } = await f.recording;
    assert.deepEqual(f.armed, []);
    f.clock.value = deadline;
    t.mock.timers.tick(VOICE_INPUT_MAX_SECONDS * 1000);
    assert.equal(f.stopReasonOf(), "limit");
    assert.equal(f.counts.trackStops, 1);
    t.mock.timers.tick(250);
    sendCommitted(f);
    sendCompleted(f, "turn", "青い傘。");
    assert.deepEqual(await f.settled(), { ok: true, value: { text: "青い傘。", audioSeconds: null } });
  } finally {
    f.capture.cancel();
  }
});
