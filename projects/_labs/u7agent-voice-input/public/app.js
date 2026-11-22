import { startTranscription } from "./transcription.js";

const byId = (id) => document.getElementById(id);
const keyForm = byId("key-form");
const keyInput = byId("api-key");
const registerKey = byId("register-key");
const clearKey = byId("clear-key");
const keyStatus = byId("key-status");
const start = byId("start");
const stop = byId("stop");
const cancel = byId("cancel");
const runStatus = byId("run-status");
const partial = byId("partial");
const transcript = byId("transcript");
const firstDelta = byId("first-delta");
const stopToFinal = byId("stop-to-final");

const ms = (since) => `${Math.round(performance.now() - since)} ms`;
let registered = false;
let keyBusy = false;
let active;
let recording = false;

function renderControls() {
  const locked = keyBusy || Boolean(active);
  keyInput.disabled = locked;
  registerKey.disabled = locked;
  clearKey.disabled = locked || !registered;
  start.disabled = locked || !registered;
  stop.disabled = !recording;
  cancel.disabled = !active;
  transcript.readOnly = Boolean(active);
}

async function updateKey(options) {
  if (keyBusy || active) return;
  keyBusy = true;
  renderControls();
  try {
    const response = await fetch("/api/key", options);
    const data = await response.json();
    if (response.ok) registered = data.registered;
    keyStatus.textContent = response.ok ? (registered ? "登録済み" : "未登録") : data.error;
  } catch {
    keyStatus.textContent = "API キーの登録状態を確認できませんでした。";
  } finally {
    keyBusy = false;
    renderControls();
  }
}

keyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = JSON.stringify({ apiKey: keyInput.value });
  keyInput.value = "";
  void updateKey({ method: "PUT", headers: { "Content-Type": "application/json" }, body });
});
clearKey.addEventListener("click", () => {
  keyInput.value = "";
  void updateKey({ method: "DELETE" });
});

function idle(message) {
  active = undefined;
  recording = false;
  runStatus.textContent = message;
  renderControls();
}

start.addEventListener("click", () => {
  if (active || !registered || keyBusy) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    idle("マイクと WebRTC を利用できるブラウザで、起動時に表示された URL を開いてください。");
    return;
  }
  partial.textContent = "";
  firstDelta.textContent = "—";
  stopToFinal.textContent = "—";
  runStatus.textContent = "マイクを確認中…";
  let gotPartial = false;
  let startedAt;
  let stoppedAt;
  active = startTranscription({
    onConnecting() {
      runStatus.textContent = "OpenAI に接続中…";
    },
    onRecording() {
      startedAt = performance.now();
      recording = true;
      runStatus.textContent = "録音中。話してください。";
      renderControls();
    },
    onPartial(text) {
      if (!gotPartial) firstDelta.textContent = ms(startedAt);
      gotPartial = true;
      partial.textContent = text;
    },
    onFinalizing() {
      stoppedAt = performance.now();
      recording = false;
      runStatus.textContent = "停止しました。確定テキストを待機中…";
      renderControls();
    },
    onFinal(text) {
      stopToFinal.textContent = ms(stoppedAt);
      transcript.value = text;
      idle(
        gotPartial
          ? "確定しました。停止前の途中表示あり。"
          : "確定しましたが、停止前の途中表示はありませんでした。",
      );
    },
    onError: idle,
  });
  renderControls();
});

stop.addEventListener("click", () => active?.stop());
function cancelRun() {
  if (!active) return;
  active.cancel();
  idle("中止しました。");
}
cancel.addEventListener("click", cancelRun);
window.addEventListener("pagehide", cancelRun);
void updateKey();
