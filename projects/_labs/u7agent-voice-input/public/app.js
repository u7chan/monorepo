import { DEFAULT_RECORDING_LIMIT_SECONDS, RECORDING_LIMITS_SECONDS, startTranscription } from "./transcription.js";

const USD_PER_AUDIO_MINUTE = 0.017;
const COUNTDOWN_WARNING_MS = 3_000;

const byId = (id) => document.getElementById(id);
const keyForm = byId("key-form");
const keyInput = byId("api-key");
const registerKey = byId("register-key");
const clearKey = byId("clear-key");
const keyStatus = byId("key-status");
const voiceButton = byId("start");
const runStatus = byId("run-status");
const transcript = byId("transcript");
const firstDelta = byId("first-delta");
const stopToFinal = byId("stop-to-final");
const metrics = stopToFinal.closest("dl");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const limitSelect = document.createElement("select");
for (const seconds of RECORDING_LIMITS_SECONDS) {
  const label = seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分`;
  limitSelect.add(new Option(label, String(seconds)));
}
limitSelect.value = String(DEFAULT_RECORDING_LIMIT_SECONDS);
const limitLabel = document.createElement("label");
limitLabel.className = "recording-limit";
limitLabel.append("自動停止時間", limitSelect);
runStatus.before(limitLabel);

const composer = document.createElement("div");
composer.className = "voice-composer";
const actions = voiceButton.parentElement;
voiceButton.className = "voice-primary";

voiceButton.innerHTML = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="13" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6" />
  </svg>
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" hidden>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
  <svg class="voice-countdown" aria-hidden="true" viewBox="0 0 48 48" fill="none" hidden>
    <circle class="voice-countdown-track" cx="24" cy="24" r="22" />
    <circle class="voice-countdown-progress" cx="24" cy="24" r="22" pathLength="1" stroke-dasharray="1 1" />
  </svg>`;
const [micIcon, stopIcon, countdown] = voiceButton.children;
const countdownProgress = countdown.lastElementChild;
const preview = byId("partial");
preview.previousElementSibling.remove();
preview.remove();
const label = document.querySelector('label[for="transcript"]');
label.className = "sr-only";
label.textContent = "メッセージ入力";
transcript.rows = 1;
transcript.placeholder = "メッセージを入力…";
transcript.before(composer);
composer.append(transcript, voiceButton);
actions.remove();

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
let countdownFrame;

function showCountdown(startedAt, deadline) {
  function tick() {
    const remainingMs = Math.max(0, deadline - performance.now());
    const fraction = Math.min(1, remainingMs / (deadline - startedAt));
    countdownProgress.setAttribute("stroke-dashoffset", String(1 - fraction));
    if (remainingMs <= COUNTDOWN_WARNING_MS && !countdown.classList.contains("is-ending")) {
      countdown.classList.add("is-ending");
      runStatus.textContent = "録音中。まもなく自動停止します。";
    }
    if (remainingMs > 0) countdownFrame = requestAnimationFrame(tick);
  }
  tick();
}

function renderControls() {
  const busy = Boolean(active);
  const locked = keyBusy || busy;
  keyInput.disabled = locked;
  registerKey.disabled = locked;
  clearKey.disabled = locked || !registered;
  limitSelect.disabled = busy;
  voiceButton.disabled = !busy && (keyBusy || !registered);
  voiceButton.setAttribute("aria-disabled", String(busy && !recording));
  const action = busy ? "停止・確定" : "録音開始";
  voiceButton.setAttribute("aria-label", action);
  voiceButton.title = action;
  micIcon.toggleAttribute("hidden", busy);
  stopIcon.toggleAttribute("hidden", !busy);
  countdown.toggleAttribute("hidden", !recording);
  transcript.readOnly = busy;
  composer.classList.toggle("is-recording", recording);
  if (!recording) {
    if (countdownFrame !== undefined) cancelAnimationFrame(countdownFrame);
    countdownFrame = undefined;
    countdown.classList.remove("is-ending");
    textGlow?.cancel();
  }
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
  if (typeof RTCRtpScriptTransform !== "function") {
    idle("録音時間の上限を適用できません。最新版の Chromium 系ブラウザで開いてください。");
    return;
  }
  firstDelta.textContent = "—";
  stopToFinal.textContent = "—";
  recordingTime.textContent = "—";
  estimatedCost.textContent = "—";
  runStatus.textContent = "マイクを確認中…";
  let gotPartial = false;
  let stoppedAtLimit = false;
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
    onRecording({ startedAt: recordingStartedAt, deadline }) {
      startedAt = recordingStartedAt;
      recording = true;
      runStatus.textContent = "録音中。話してください。";
      renderControls();
      showCountdown(startedAt, deadline);
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
    onFinalizing(reason, audioStoppedAt) {
      stoppedAt = audioStoppedAt;
      stoppedAtLimit = reason === "limit";
      recording = false;
      const recordingSeconds = (stoppedAt - startedAt) / 1000;
      recordingTime.textContent = secondsLabel(recordingSeconds);
      showCost(recordingSeconds, "録音時間ベース");
      runStatus.textContent = stoppedAtLimit
        ? "上限で自動停止しました。確定テキストを待機中…"
        : "停止しました。確定テキストを待機中…";
      renderControls();
    },
    onFinal({ text, audioSeconds }) {
      stopToFinal.textContent = ms(stoppedAt);
      insertText(text);
      if (audioSeconds !== null) showCost(audioSeconds, `API 計測 ${secondsLabel(audioSeconds)}`);
      const finished = stoppedAtLimit ? "上限で自動停止し、確定しました" : "確定しました";
      idle(
        gotPartial
          ? `${finished}。停止前の途中表示あり。`
          : `${finished}が、停止前の途中表示はありませんでした。`,
      );
    },
    onError(message) {
      restoreDraft();
      idle(message);
    },
  }, { limitSeconds: Number(limitSelect.value) });
  active = {
    stop: capture.stop,
    cancel() {
      capture.cancel();
      restoreDraft();
    },
  };
  renderControls();
});

window.addEventListener("pagehide", () => {
  if (!active) return;
  active.cancel();
  idle("ページを離れたため録音を終了しました。");
});
void updateKey();
