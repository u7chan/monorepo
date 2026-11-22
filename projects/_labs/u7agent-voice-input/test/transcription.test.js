import { expect, mock, test } from "bun:test";
import { startTranscription } from "../public/transcription.js";

const eventPrefix = "conversation.item.input_audio_transcription.";

function fixture({ delayedMicrophone = false } = {}) {
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
    onFinal: (text) => result.resolve({ text }),
    onError: (error) => result.resolve({ error }),
  };
  const platform = {
    getMicrophone: () => (delayedMicrophone ? permission.promise : Promise.resolve(stream)),
    makePeer: mock(() => peer),
    request: mock(async (path, _init) => (path === "/api/session"
      ? Response.json({ value: "ek_fixture" })
      : new Response("fixture answer"))),
  };
  const capture = startTranscription(callbacks, platform);
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
    callbacks,
    platform,
  };
}

test("停止前に差分を表示し、停止後は commit した発話の確定テキストだけを採用する", async () => {
  const f = fixture();
  try {
    await f.recording;
    expect(f.track.enabled).toBe(true);
    expect(f.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    const [url, options] = f.platform.request.mock.calls[1];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(options.headers.Authorization).toBe("Bearer ek_fixture");

    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "青い" });
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "傘" });
    expect(f.callbacks.onPartial.mock.calls).toEqual([["青い"], ["青い傘"]]);

    f.capture.stop();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.peer.close).not.toHaveBeenCalled();
    f.receive({ type: `${eventPrefix}delta`, item_id: "turn", delta: "を持って" });
    expect(f.callbacks.onPartial).toHaveBeenCalledTimes(2);
    expect(await f.commit).toEqual({ type: "input_audio_buffer.commit" });
    f.receive({ type: `${eventPrefix}completed`, item_id: "other", transcript: "別の発話" });
    f.receive({ type: `${eventPrefix}completed`, item_id: "turn", transcript: "青い傘を持って。" });
    expect(f.peer.close).not.toHaveBeenCalled();
    f.receive({ type: "input_audio_buffer.committed", item_id: "turn" });
    expect(await f.result).toEqual({ text: "青い傘を持って。" });
    expect(f.peer.close).toHaveBeenCalledTimes(1);
  } finally {
    f.capture.cancel();
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
    expect(await f.result).toEqual({ text: "青い傘。" });
    expect(f.callbacks.onPartial).not.toHaveBeenCalled();
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
