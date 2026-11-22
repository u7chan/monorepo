import { expect, jest, mock, test } from "bun:test";
import { audioBeforeDeadline, startTranscription } from "../public/transcription.js";

const eventPrefix = "conversation.item.input_audio_transcription.";

function fixture({ delayedMicrophone = false, limitSeconds } = {}) {
  const recording = Promise.withResolvers();
  const commit = Promise.withResolvers();
  const result = Promise.withResolvers();
  const permission = Promise.withResolvers();
  const track = Object.assign(new EventTarget(), { enabled: true, stop: mock(() => {}) });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = Object.assign(new EventTarget(), {
    close: mock(() => {}),
    send: (message) => commit.resolve(JSON.parse(message)),
  });
  const peer = Object.assign(new EventTarget(), {
    addTrack: mock(() => {}),
    createDataChannel: mock(() => channel),
    createOffer: async () => ({ type: "offer", sdp: "fixture offer" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => channel.dispatchEvent(new Event("open")),
    close: mock(() => {}),
  });
  const callbacks = {
    onConnecting: mock(() => {}),
    onRecording: recording.resolve,
    onFinalizing: mock(() => {}),
    onPartial: mock(() => {}),
    onFinal: result.resolve,
    onError: (error) => result.resolve({ error }),
  };
  const audioDeadline = { attach: mock(() => {}), arm: mock(() => {}), close: mock(() => {}) };
  const platform = {
    getMicrophone: () => (delayedMicrophone ? permission.promise : Promise.resolve(stream)),
    makePeer: mock(() => peer),
    makeAudioDeadline: mock(() => audioDeadline),
    request: mock(async (path, _init) => (path === "/api/session"
      ? Response.json({ value: "ek_fixture" })
      : new Response("fixture answer"))),
  };
  const capture = startTranscription(callbacks, { limitSeconds, platform });
  const receive = (event) => channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  return {
    recording: recording.promise,
    commit: commit.promise,
    result: result.promise,
    releasePermission: () => permission.resolve(stream),
    capture,
    receive,
    channel,
    peer,
    track,
    audioDeadline,
    callbacks,
    platform,
  };
}

test("音声の送信は開始前と期限以降のフレームを通さない", async () => {
  let now = 100;
  let deadline = -Infinity;
  const filter = audioBeforeDeadline(() => deadline, () => now);
  const writer = filter.writable.getWriter();
  const sent = [];
  const done = filter.readable.pipeTo(new WritableStream({ write(frame) { sent.push(frame); } }));
  await writer.write("接続中");
  deadline = 200;
  await writer.write("期限前");
  now = 200;
  await writer.write("期限時点");
  now = 850;
  await writer.write("画面が固まっている間の期限後");
  await writer.close();
  await done;
  expect(sent).toEqual(["期限前"]);
});

test("停止前に差分を表示し、停止後は commit した発話の確定テキストと音声秒数だけを採用する", async () => {
  const f = fixture();
  try {
    await f.recording;
    expect(f.track.enabled).toBe(true);
    expect(f.audioDeadline.attach).toHaveBeenCalledTimes(1);
    expect(f.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    const [url, options] = f.platform.request.mock.calls[1];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(options.headers.Authorization).toBe("Bearer ek_fixture");

    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "青い" });
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "傘" });
    expect(f.callbacks.onPartial.mock.calls).toEqual([["青い"], ["青い傘"]]);

    f.capture.stop();
    expect(f.callbacks.onFinalizing).toHaveBeenCalledWith("manual", expect.any(Number));
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.peer.close).not.toHaveBeenCalled();
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "を持って" });
    expect(f.callbacks.onPartial).toHaveBeenCalledTimes(2);
    expect(await f.commit).toEqual({ type: "input_audio_buffer.commit" });
    f.receive({
      type: `${eventPrefix}completed`, item_id: "other", transcript: "別の発話",
      usage: { type: "duration", seconds: 43 },
    });
    f.receive({
      type: `${eventPrefix}completed`, item_id: "turn", transcript: "青い傘を持って。",
      usage: { type: "duration", seconds: 12.25 },
    });
    expect(f.peer.close).not.toHaveBeenCalled();
    f.receive({ type: "input_audio_buffer.committed", item_id: "turn" });
    expect(await f.result).toEqual({ text: "青い傘を持って。", audioSeconds: 12.25 });
    expect(f.peer.close).toHaveBeenCalledTimes(1);
    expect(f.audioDeadline.close).toHaveBeenCalledTimes(1);
  } finally {
    f.capture.cancel();
  }
});

test.each([10, 30, 60, 120])("選んだ %i 秒を録音してから自動停止し、通常どおり確定する", async (limitSeconds) => {
  jest.useFakeTimers();
  const f = fixture({ delayedMicrophone: true, limitSeconds });
  try {
    jest.advanceTimersByTime(5_000);
    f.releasePermission();
    const { startedAt, deadline } = await f.recording;
    expect(deadline - startedAt).toBe(limitSeconds * 1000);
    expect(f.audioDeadline.arm).toHaveBeenCalledWith(deadline);

    jest.advanceTimersByTime(limitSeconds * 1000 - 1);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.callbacks.onFinalizing).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onFinalizing.mock.calls).toEqual([["limit", expect.any(Number)]]);

    jest.advanceTimersByTime(250);
    expect(await f.commit).toEqual({ type: "input_audio_buffer.commit" });
    f.receive({ type: "input_audio_buffer.committed", item_id: "turn" });
    f.receive({ type: `${eventPrefix}completed`, item_id: "turn", transcript: "青い傘。" });
    expect(await f.result).toEqual({ text: "青い傘。", audioSeconds: null });
    expect(f.peer.close).toHaveBeenCalledTimes(1);
  } finally {
    f.capture.cancel();
    jest.useRealTimers();
  }
});

test("確定までに発話中の差分がなくても、停止後の delta を途中表示として報告しない", async () => {
  const f = fixture();
  try {
    await f.recording;
    f.capture.stop();
    await f.commit;
    f.receive({ type: "input_audio_buffer.committed", item_id: "turn" });
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "青い" });
    f.receive({ type: `${eventPrefix}completed`, item_id: "turn", transcript: "青い傘。" });
    expect(await f.result).toEqual({ text: "青い傘。", audioSeconds: null });
    expect(f.callbacks.onPartial).not.toHaveBeenCalled();
  } finally {
    f.capture.cancel();
  }
});

test.each([
  [{ type: "tokens", seconds: 12 }, null],
  [{ type: "duration", seconds: "12" }, null],
  [{ type: "duration", seconds: -1 }, null],
  [{ type: "duration", seconds: 0 }, 0],
])("音声秒数の形式を判定する: %j", async (usage, audioSeconds) => {
  const f = fixture();
  try {
    await f.recording;
    f.capture.stop();
    await f.commit;
    f.receive({ type: "input_audio_buffer.committed", item_id: "turn" });
    f.receive({ type: `${eventPrefix}completed`, item_id: "turn", transcript: "青い傘。", usage });
    expect(await f.result).toEqual({ text: "青い傘。", audioSeconds });
  } finally {
    f.capture.cancel();
  }
});

test("マイク許可待ちで中止した場合、後から得たマイクを解放し OpenAI に接続しない", async () => {
  const f = fixture({ delayedMicrophone: true });
  f.capture.cancel();
  f.releasePermission();
  await Promise.resolve();
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.platform.makePeer).not.toHaveBeenCalled();
  expect(f.platform.request).not.toHaveBeenCalled();
});

test("録音中に接続が切れた場合もマイクを解放する", async () => {
  const f = fixture();
  try {
    await f.recording;
    f.channel.dispatchEvent(new Event("close"));
    expect((await f.result).error).toContain("接続が閉じました");
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.peer.close).toHaveBeenCalledTimes(1);
  } finally {
    f.capture.cancel();
  }
});
