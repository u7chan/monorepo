export const RECORDING_LIMITS_SECONDS = [10, 30, 60, 120];
export const DEFAULT_RECORDING_LIMIT_SECONDS = RECORDING_LIMITS_SECONDS.at(-1);

const CALL_URL = "https://api.openai.com/v1/realtime/calls";
const CONNECT_TIMEOUT_MS = 30_000;
const AUDIO_DRAIN_MS = 250;
const FINAL_TIMEOUT_MS = 15_000;

const audioClock = () => performance.timeOrigin + performance.now();

export function audioBeforeDeadline(deadline, now = audioClock) {
  return new TransformStream({
    transform(frame, output) {
      if (now() < deadline()) output.enqueue(frame);
    },
  });
}

if (typeof DedicatedWorkerGlobalScope !== "undefined" && globalThis instanceof DedicatedWorkerGlobalScope) {
  let deadline = -Infinity;
  globalThis.addEventListener("message", ({ data }) => {
    if (deadline === -Infinity && Number.isFinite(data)) deadline = data;
  });
  globalThis.addEventListener("rtctransform", ({ transformer }) => {
    void transformer.readable
      .pipeThrough(audioBeforeDeadline(() => deadline))
      .pipeTo(transformer.writable)
      .catch(() => globalThis.postMessage("audio-filter-error"));
  });
}

function makeAudioDeadline(onError) {
  // 画面側のタイマーだけでは、メインスレッドの停止中も音声が送られ続ける。
  const worker = new Worker(import.meta.url, { type: "module" });
  worker.addEventListener("error", onError);
  worker.addEventListener("message", onError);
  return {
    attach(sender) {
      sender.transform = new RTCRtpScriptTransform(worker);
    },
    arm(deadline) {
      worker.postMessage(performance.timeOrigin + deadline);
    },
    close() {
      worker.terminate();
    },
  };
}

const browser = {
  getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
  makePeer: () => new RTCPeerConnection(),
  makeAudioDeadline,
  request: (...args) => fetch(...args),
};

function audioDurationSeconds(usage) {
  const seconds = usage?.seconds;
  return usage?.type === "duration" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function startTranscription(callbacks, { limitSeconds, platform = browser } = {}) {
  const seconds = RECORDING_LIMITS_SECONDS.includes(limitSeconds) ? limitSeconds : DEFAULT_RECORDING_LIMIT_SECONDS;
  const limitMs = seconds * 1000;
  const abort = new AbortController();
  let phase = "connecting";
  let stream;
  let peer;
  let channel;
  let audioDeadline;
  let deadline;
  let timer;
  let previewItemId;
  let preview = "";
  let commitSent = false;
  let committedId;
  const outcomes = new Map();

  function schedule(ms, action) {
    clearTimeout(timer);
    timer = setTimeout(action, ms);
  }

  function stopMicrophone() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }

  function close() {
    if (phase === "closed") return;
    phase = "closed";
    clearTimeout(timer);
    abort.abort();
    stopMicrophone();
    channel?.close();
    peer?.close();
    audioDeadline?.close();
  }

  function fail(message) {
    if (phase === "closed") return;
    close();
    callbacks.onError(message);
  }

  function stop(reason = "manual") {
    if (phase !== "recording") return;
    phase = "finalizing";
    const stoppedAt = Math.min(performance.now(), deadline);
    stopMicrophone();
    callbacks.onFinalizing(reason, stoppedAt);
    // 音声と制御は別経路なので、停止と同時に commit すると末尾の音声を追い越しうる。
    schedule(AUDIO_DRAIN_MS, () => {
      if (phase !== "finalizing") return;
      schedule(FINAL_TIMEOUT_MS, () => fail("確定テキストを受け取る前にタイムアウトしました。"));
      commitSent = true;
      try {
        channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        fail("録音の確定を要求できませんでした。");
      }
    });
  }

  function receive(data) {
    if (phase === "closed" || typeof data !== "string") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const itemId = event?.item_id;
    switch (event?.type) {
      case "error":
        fail(
          event.error?.code === "input_audio_buffer_commit_empty"
            ? "音声が短すぎて確定できませんでした。もう一度話してください。"
            : "OpenAI の Realtime セッションでエラーが発生しました。",
        );
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (phase === "recording" && typeof itemId === "string" && typeof event.delta === "string") {
          previewItemId ??= itemId;
          if (previewItemId === itemId) {
            preview += event.delta;
            if (preview.trim()) callbacks.onPartial(preview);
          }
        }
        return;
    }
    if (!commitSent || typeof itemId !== "string") return;
    if (event.type === "input_audio_buffer.committed") {
      committedId ??= itemId;
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = typeof event.transcript === "string" ? event.transcript : "";
      outcomes.set(itemId, { text, audioSeconds: audioDurationSeconds(event.usage) });
    } else if (event.type === "conversation.item.input_audio_transcription.failed") {
      outcomes.set(itemId, null);
    }
    // 確定イベントが commit の確認より先に届いても落とさない。
    if (!outcomes.has(committedId)) return;
    const outcome = outcomes.get(committedId);
    if (!outcome?.text.trim()) {
      fail("有効な確定テキストを受け取れませんでした。");
      return;
    }
    close();
    callbacks.onFinal(outcome);
  }

  async function connect() {
    const microphone = await platform.getMicrophone();
    if (abort.signal.aborted) {
      microphone.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = microphone;
    callbacks.onConnecting();
    peer = platform.makePeer();
    audioDeadline = platform.makeAudioDeadline(() => {
      if (phase === "connecting" || phase === "recording") fail("音声の送信を制御できませんでした。");
    });
    const tracks = stream.getAudioTracks();
    for (const track of tracks) {
      track.enabled = false;
      track.addEventListener("ended", () => {
        if (phase === "connecting" || phase === "recording") fail("マイクの接続が切れました。");
      });
      audioDeadline.attach(peer.addTrack(track, stream));
    }
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        fail("WebRTC の接続が切れました。");
      }
    });
    channel = peer.createDataChannel("oai-events");
    channel.addEventListener("open", () => {
      if (phase !== "connecting") return;
      const startedAt = performance.now();
      deadline = startedAt + limitMs;
      audioDeadline.arm(deadline);
      for (const track of tracks) track.enabled = true;
      phase = "recording";
      schedule(limitMs, () => stop("limit"));
      callbacks.onRecording({ startedAt, deadline });
    });
    channel.addEventListener("message", ({ data }) => receive(data));
    channel.addEventListener("close", () => fail("確定前に OpenAI との接続が閉じました。"));
    channel.addEventListener("error", () => fail("OpenAI とのデータ通信でエラーが発生しました。"));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const secretResponse = await platform.request("/api/session", {
      method: "POST",
      signal: abort.signal,
    });
    const secret = await secretResponse.json().catch(() => null);
    if (!secretResponse.ok || typeof secret?.value !== "string") {
      fail(secret?.error ?? "ローカルサーバーから短命キーを取得できませんでした。");
      return;
    }
    const answer = await platform.request(CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret.value}`,
        "Content-Type": "application/sdp",
        Accept: "application/sdp",
      },
      body: offer.sdp,
      redirect: "error",
      signal: abort.signal,
    });
    if (!answer.ok) {
      fail(`OpenAI との WebRTC セッションを開始できませんでした（HTTP ${answer.status}）。`);
      return;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await answer.text() });
  }

  schedule(CONNECT_TIMEOUT_MS, () => fail("マイクの許可または WebRTC 接続がタイムアウトしました。"));
  void connect().catch((error) => {
    if (stream) fail("WebRTC 接続を開始できませんでした。");
    else if (error?.name === "NotAllowedError") fail("ブラウザでマイクの利用を許可してください。");
    else fail("マイクを利用できませんでした。");
  });
  return { stop, cancel: close };
}
