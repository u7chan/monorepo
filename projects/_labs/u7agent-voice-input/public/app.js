import { startTranscription } from "./transcription.js";

const USD_PER_AUDIO_MINUTE = 0.017;

const byId = (id) => document.getElementById(id);
const keyForm = byId("key-form");
const keyInput = byId("api-key");
const registerKey = byId("register-key");
const clearKey = byId("clear-key");
const keyStatus = byId("key-status");
const voiceButton = byId("start");
const cancel = byId("cancel");
const runStatus = byId("run-status");
const transcript = byId("transcript");
const firstDelta = byId("first-delta");
const stopToFinal = byId("stop-to-final");
const metrics = stopToFinal.closest("dl");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const composer = document.createElement("div");
composer.className = "voice-composer";
const actions = voiceButton.parentElement;
actions.className = "voice-actions";
voiceButton.className = "voice-primary";
cancel.className = "voice-cancel";
cancel.title = "中止";
cancel.setAttribute("aria-label", "中止");
cancel.textContent = "×";

const sparkles = document.createElement("span");
sparkles.className = "voice-sparkles";
sparkles.setAttribute("aria-hidden", "true");
sparkles.textContent = "✦";
voiceButton.innerHTML = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="13" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6" />
  </svg>
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" hidden>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>`;
const [micIcon, stopIcon] = voiceButton.children;
actions.replaceChildren(sparkles, cancel, voiceButton);
const preview = byId("partial");
preview.previousElementSibling.remove();
preview.remove();
const label = document.querySelector('label[for="transcript"]');
label.className = "sr-only";
label.textContent = "メッセージ入力";
transcript.rows = 1;
transcript.placeholder = "メッセージを入力…";
transcript.before(composer);
composer.append(transcript, actions);

function addMetric(label) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const value = document.createElement("dd");
  term.textContent = label;
  value.textContent = "—";
  row.append(term, value);
  metrics.append(row);
  return value;
}

const recordingTime = addMetric("録音時間（合計）");
const estimatedCost = addMetric("今回の概算");

const ms = (since) => `${Math.round(performance.now() - since)} ms`;
const secondsLabel = (seconds) => `${seconds.toFixed(1)} 秒`;

function showCost(audioSeconds, basis) {
  const usd = (audioSeconds / 60) * USD_PER_AUDIO_MINUTE;
  estimatedCost.textContent = `$${usd.toFixed(4)}（${basis}）`;
}

let registered = false;
let keyBusy = false;
let active;
let recording = false;
let textGlow;

function renderControls() {
  const busy = Boolean(active);
  const locked = keyBusy || busy;
  keyInput.disabled = locked;
  registerKey.disabled = locked;
  clearKey.disabled = locked || !registered;
  voiceButton.disabled = !busy && (keyBusy || !registered);
  voiceButton.setAttribute("aria-disabled", String(busy && !recording));
  const action = busy ? "停止・確定" : "録音開始";
  voiceButton.setAttribute("aria-label", action);
  voiceButton.title = action;
  micIcon.toggleAttribute("hidden", busy);
  stopIcon.toggleAttribute("hidden", !busy);
  cancel.hidden = !busy;
  cancel.disabled = !busy;
  transcript.readOnly = busy;
  composer.classList.toggle("is-recording", recording);
  if (!recording) textGlow?.cancel();
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
  const cancelFocused = document.activeElement === cancel;
  active = undefined;
  recording = false;
  runStatus.textContent = message;
  renderControls();
  if (cancelFocused) voiceButton.focus();
}

voiceButton.addEventListener("click", () => {
  if (active) {
    active.stop();
    return;
  }
  if (!registered || keyBusy) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    idle("マイクと WebRTC を利用できるブラウザで、起動時に表示された URL を開いてください。");
    return;
  }
  firstDelta.textContent = "—";
  stopToFinal.textContent = "—";
  recordingTime.textContent = "—";
  estimatedCost.textContent = "—";
  runStatus.textContent = "マイクを確認中…";
  let gotPartial = false;
  let startedAt;
  let stoppedAt;
  const draft = transcript.value;
  const from = transcript.selectionStart;
  const to = transcript.selectionEnd;
  const before = draft.slice(0, from);
  const after = draft.slice(to);
  const restoreDraft = () => {
    transcript.value = draft;
    transcript.setSelectionRange(from, to);
  };
  const insertText = (text) => {
    transcript.value = before + text + after;
    const caret = from + text.length;
    transcript.setSelectionRange(caret, caret);
    if (!after) transcript.scrollTop = transcript.scrollHeight;
  };
  const capture = startTranscription({
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
      insertText(text);
      if (!reducedMotion.matches) {
        textGlow?.cancel();
        textGlow = transcript.animate(
          [{ textShadow: "0 0 12px var(--voice-accent)" }, { textShadow: "0 0 0 transparent" }],
          { duration: 550, easing: "ease-out" },
        );
      }
    },
    onFinalizing() {
      stoppedAt = performance.now();
      recording = false;
      const recordingSeconds = (stoppedAt - startedAt) / 1000;
      recordingTime.textContent = secondsLabel(recordingSeconds);
      showCost(recordingSeconds, "録音時間ベース");
      runStatus.textContent = "停止しました。確定テキストを待機中…";
      renderControls();
    },
    onFinal({ text, audioSeconds }) {
      stopToFinal.textContent = ms(stoppedAt);
      insertText(text);
      if (audioSeconds !== null) showCost(audioSeconds, `API 計測 ${secondsLabel(audioSeconds)}`);
      idle(
        gotPartial
          ? "確定しました。停止前の途中表示あり。"
          : "確定しましたが、停止前の途中表示はありませんでした。",
      );
    },
    onError(message) {
      restoreDraft();
      idle(message);
    },
  });
  active = {
    stop: capture.stop,
    cancel() {
      capture.cancel();
      restoreDraft();
    },
  };
  renderControls();
});

function cancelRun() {
  if (!active) return;
  active.cancel();
  idle("中止しました。");
}
cancel.addEventListener("click", cancelRun);
window.addEventListener("pagehide", cancelRun);
void updateKey();
