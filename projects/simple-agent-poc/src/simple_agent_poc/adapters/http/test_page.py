"""Development test page for chat, streaming, and ask_user resume."""

TEST_PAGE_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>simple-agent-poc - Test Page</title>
<style>
  :root { --bg: #18181b; --surface: #27272a; --border: #3f3f46; --text: #e4e4e7; --muted: #a1a1aa; --accent: #22c55e; --error: #ef4444; --tool: #3b82f6; --pause: #f59e0b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, 'Cascadia Code', monospace; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 14px; font-weight: 600; margin-right: auto; }
  header label { font-size: 12px; color: var(--muted); }
  header input, header select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 12px; }
  header button { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; font-family: inherit; font-size: 12px; cursor: pointer; }
  header button:hover { background: var(--border); }
  main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .logs { flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 8px; gap: 8px; }
  .log-section { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .log-section summary { font-size: 12px; color: var(--muted); cursor: pointer; padding: 4px 0; user-select: none; }
  .log-section pre { flex: 1; overflow-y: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-family: inherit; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  footer { background: var(--surface); border-top: 1px solid var(--border); padding: 8px 12px; }
  .input-row { display: flex; gap: 6px; }
  .input-row input[type="text"] { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-family: inherit; font-size: 13px; }
  .input-row input[type="text"]:disabled { opacity: 0.45; cursor: not-allowed; }
  .input-row button { background: var(--accent); color: #000; border: none; border-radius: 4px; padding: 6px 14px; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .input-row button:disabled { opacity: 0.4; cursor: not-allowed; }
  .input-row button.stop { background: var(--error); color: #fff; }
  .paused-bar { display: none; background: var(--pause); color: #000; padding: 8px 12px; font-size: 13px; font-weight: 600; }
  .paused-bar.visible { display: flex; gap: 12px; align-items: center; }
  .paused-bar input[type="text"] { flex: 1; background: rgba(0,0,0,.15); color: #000; border: 1px solid rgba(0,0,0,.2); border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 13px; }
  .paused-bar button { background: rgba(120,53,15,.24); color: #000; border: 1px solid rgba(120,53,15,.24); border-radius: 4px; min-height: 36px; padding: 4px 14px; font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1; cursor: pointer; transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
  .paused-bar button:hover:not(:disabled) { background: rgba(120,53,15,.38); border-color: rgba(120,53,15,.36); }
  .paused-bar button:disabled { opacity: 0.45; cursor: not-allowed; }
  .paused-choices { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; align-items: center; }
  .paused-choice-btn { background: rgba(120,53,15,.28); color: #000; border: 1px solid rgba(120,53,15,.32); border-radius: 4px; min-height: 36px; padding: 4px 14px; font-family: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
  .paused-choice-btn:hover { background: rgba(120,53,15,.44); border-color: rgba(120,53,15,.44); }
  .paused-choice-btn.selected { background: var(--accent); color: #000; border-color: var(--accent); }
  .paused-choice-btn.selected:hover { background: #16a34a; border-color: #16a34a; }
  .paused-questions-scroll { flex: 1; max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .paused-q-row { display: flex; gap: 6px; align-items: center; }
  .paused-q-label { font-size: 12px; color: #000; white-space: nowrap; min-width: fit-content; }
  .paused-q-input { flex: 1; background: rgba(0,0,0,.15); color: #000; border: 1px solid rgba(0,0,0,.2); border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 13px; }
  .paused-actions { display: flex; gap: 6px; justify-content: flex-end; flex-shrink: 0; margin-left: auto; }
  .line-user { color: var(--muted); }
  .line-assistant { color: var(--text); }
  .line-tool { color: var(--tool); }
  .line-paused { color: var(--pause); }
  .line-error { color: var(--error); }
  .line-system { color: var(--muted); font-style: italic; }
  .model-badge { font-size: 11px; font-family: ui-monospace, 'Cascadia Code', monospace; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; margin: 0 10px 0 4px; white-space: nowrap; }
</style>
</head>
<body>
<header>
  <h1>simple-agent-poc</h1>
  <label>Mode
    <select id="mode-select" onchange="onModeChange()">
      <option value="stream">stream</option>
      <option value="sync">sync</option>
    </select>
  </label>
  <label>Agent
    <select id="agent-id" onchange="onAgentIdChange()">
    </select>
  </label>
  <span id="agent-model" class="model-badge"></span>
  <label>Session
    <input type="text" id="session-id" size="24" placeholder="(new)" onchange="onSessionIdChange()">
  </label>
  <button onclick="clearSession()">Clear</button>
</header>
<main>
  <div class="logs">
    <details class="log-section" open>
      <summary>Conversation</summary>
      <pre id="conv-log"></pre>
    </details>
    <details class="log-section">
      <summary>Tool Calls</summary>
      <pre id="tool-log"></pre>
    </details>
    <details class="log-section">
      <summary>Raw</summary>
      <pre id="raw-log"></pre>
    </details>
  </div>
  <div class="paused-bar" id="paused-bar">
    <div class="paused-questions-scroll" id="paused-questions"></div>
    <div class="paused-actions">
      <button id="paused-resume" onclick="resumeFromPaused()">Submit Answer</button>
      <button onclick="cancelPaused()">Cancel</button>
    </div>
  </div>
</main>
<footer>
  <div class="input-row">
    <input type="text" id="msg-input" placeholder="Type a message..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}">
    <button id="send-btn" onclick="sendMessage()">Send</button>
    <button id="stop-btn" class="stop" onclick="stopRequest()" style="display:none">Stop</button>
  </div>
</footer>
<script>
const state = {
  mode: "stream",
  agentId: "default",
  sessionId: "",
  awaitingAnswer: null,
  abortController: null,
};

const el = (id) => document.getElementById(id);

function onModeChange() {
  state.mode = el("mode-select").value;
  persist();
}

function onAgentIdChange() {
  state.agentId = el("agent-id").value;
  const option = el("agent-id").selectedOptions[0];
  if (option && option.dataset.model) {
    el("agent-model").textContent = option.dataset.model;
  } else {
    el("agent-model").textContent = "";
  }
  persist();
}

function onSessionIdChange() {
  state.sessionId = el("session-id").value.trim();
  persist();
}

function setSessionId(id) {
  state.sessionId = id;
  el("session-id").value = id;
  persist();
}

function persist() {
  try {
    localStorage.setItem("sap_test_ui", JSON.stringify({
      mode: state.mode,
      agentId: state.agentId,
    }));
  } catch (_) {}
}

function restore() {
  try {
    const raw = localStorage.getItem("sap_test_ui");
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.mode) { state.mode = d.mode; el("mode-select").value = d.mode; }
    if (d.agentId) { state.agentId = d.agentId; }
  } catch (_) {}
}

async function fetchAgents() {
  try {
    const resp = await fetch("/api/agents");
    if (!resp.ok) return;
    const data = await resp.json();
    const select = el("agent-id");
    select.innerHTML = "";
    const agentIds = [];
    for (const agent of data.agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.id;
      option.dataset.model = agent.model;
      select.appendChild(option);
      agentIds.push(agent.id);
    }
    if (state.agentId && agentIds.includes(state.agentId)) {
      select.value = state.agentId;
    } else if (agentIds.length > 0) {
      select.value = agentIds[0];
      state.agentId = agentIds[0];
    }
    onAgentIdChange();
  } catch (_) {}
}

function clearSession() {
  state.sessionId = "";
  state.awaitingAnswer = null;
  el("session-id").value = "";
  el("conv-log").textContent = "";
  el("tool-log").textContent = "";
  el("raw-log").textContent = "";
  el("paused-bar").classList.remove("visible");
  el("paused-questions").innerHTML = "";
  updateComposerState();
  persist();
}

function appendLog(area, className, text) {
  const pre = el(area);
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

function appendLine(area, className, text) {
  appendLog(area, className, text + "\\n");
}

function finishLogLine(node) {
  if (node && !node.textContent.endsWith("\\n")) {
    node.textContent += "\\n";
  }
}

function appendJson(area, className, obj) {
  appendLine(area, className, JSON.stringify(obj, null, 2));
}

function updateComposerState() {
  const sendBtn = el("send-btn");
  const stopBtn = el("stop-btn");
  const msgInput = el("msg-input");
  const isSending = state.abortController !== null;
  const isPaused = state.awaitingAnswer !== null;

  sendBtn.style.display = isSending ? "none" : "";
  stopBtn.style.display = isSending ? "" : "none";
  msgInput.disabled = isSending || isPaused;
  sendBtn.disabled = isPaused;

  if (!msgInput.disabled) msgInput.focus();
}

function updatePausedSubmitState() {
  const resumeBtn = el("paused-resume");
  const qInputs = el("paused-questions").querySelectorAll(".paused-q-input");
  const hasAnswer = Array.from(qInputs).some(input => input.value.trim());
  resumeBtn.disabled = !hasAnswer;
}

function setSending(sending) {
  if (!sending) state.abortController = null;
  updateComposerState();
}

async function sendMessage() {
  const message = el("msg-input").value.trim();
  if (!message) return;
  if (state.abortController) return;

  // If paused, treat the typed message as the answer for first question
  if (state.awaitingAnswer) {
    const qInputs = el("paused-questions").querySelectorAll(".paused-q-input");
    if (qInputs.length === 1) {
      qInputs[0].value = message;
      el("msg-input").value = "";
      await resumeFromPaused();
    } else {
      if (qInputs.length > 0) qInputs[0].value = message;
      el("msg-input").value = "";
      qInputs[0]?.focus();
    }
    return;
  }

  el("msg-input").value = "";
  appendLine("conv-log", "line-user", "You: " + message);
  appendLine("raw-log", "line-system", "--- sending message ---");
  if (state.mode === "stream") {
    await sendStreamMessage(message);
  } else {
    await sendSyncMessage(message);
  }
}

async function sendSyncMessage(message) {
  const controller = new AbortController();
  state.abortController = controller;
  setSending(true);
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.sessionId) headers["Session-Id"] = state.sessionId;
    const resp = await fetch("/api/chat/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({ message, agent_id: state.agentId }),
      signal: controller.signal,
    });
    appendJson("raw-log", "line-system", { status: resp.status });
    if (!resp.ok) {
      const err = await resp.json();
      appendLine("conv-log", "line-error", "Error: " + (err.detail || resp.statusText));
      appendJson("raw-log", "line-error", err);
      return;
    }
    const data = await resp.json();
    appendJson("raw-log", "line-system", data);
    if (data.status === "paused") {
      const qs = data.questions || [];
      const labels = qs.map(q => q.question || "").join(", ");
      appendLine("conv-log", "line-paused", "  [Paused] " + labels);
      enterPausedState({ session_id: data.session_id, questions: qs, call_id: data.call_id, mode: "sync" });
      return;
    }
    appendLine("conv-log", "line-assistant", "Assistant: " + data.message);
    if (data.tool_calls && data.tool_calls.length > 0) {
      for (const tc of data.tool_calls) {
        appendLine("conv-log", "line-tool", "  Tool: " + tc.name + "(" + tc.arguments + ") -> " + truncate(tc.result, 200));
        appendJson("tool-log", "line-tool", tc);
      }
    }
    if (data.session_id) setSessionId(data.session_id);
    if (data.usage) {
      appendLine("raw-log", "line-system", "usage: " + JSON.stringify(data.usage));
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      appendLine("conv-log", "line-error", "Error: " + e.message);
    }
  } finally {
    state.abortController = null;
    setSending(false);
  }
}

async function sendStreamMessage(message) {
  const controller = new AbortController();
  state.abortController = controller;
  setSending(true);
  let assistantText = "";
  const assistantSpan = document.createElement("span");
  assistantSpan.className = "line-assistant";
  assistantSpan.textContent = "Assistant: ";
  el("conv-log").appendChild(assistantSpan);
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.sessionId) headers["Session-Id"] = state.sessionId;
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ message, agent_id: state.agentId }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.text();
      appendLine("conv-log", "line-error", "Error: " + err);
      return;
    }
    await readSseStream(resp, (event) => {
      if (event.type === "delta") {
        const d = JSON.parse(event.data);
        assistantText += d.content;
        assistantSpan.textContent = "Assistant: " + assistantText;
        el("conv-log").scrollTop = el("conv-log").scrollHeight;
      } else if (event.type === "tool_call") {
        const d = JSON.parse(event.data);
        appendLine("conv-log", "line-tool", "  Tool: " + d.name + "(" + d.arguments + ")");
        appendJson("tool-log", "line-tool", d);
      } else if (event.type === "tool_result") {
        const d = JSON.parse(event.data);
        appendLine("conv-log", "line-tool", "  Result: " + truncate(d.result, 200));
        appendJson("tool-log", "line-tool", d);
      } else if (event.type === "paused") {
        const d = JSON.parse(event.data);
        const qs = d.questions || [];
        const labels = qs.map(q => q.question || "").join(", ");
        appendLine("conv-log", "line-paused", "  [Paused] " + labels);
        enterPausedState(d);
      } else if (event.type === "complete") {
        const d = JSON.parse(event.data);
        if (d.session_id) setSessionId(d.session_id);
        if (d.usage) {
          appendLine("raw-log", "line-system", "usage: " + JSON.stringify(d.usage));
        }
      } else if (event.type === "error") {
        const d = JSON.parse(event.data);
        appendLine("conv-log", "line-error", "Error: " + (d.detail || "unknown error"));
      }
      appendLine("raw-log", "line-system", "[" + event.type + "] " + event.data);
    });
  } catch (e) {
    if (e.name !== "AbortError") {
      appendLine("conv-log", "line-error", "Error: " + e.message);
    }
  } finally {
    finishLogLine(assistantSpan);
    state.abortController = null;
    setSending(false);
  }
}

function enterPausedState({ session_id: sessionId, questions, call_id: callId, mode = "stream" }) {
  const qs = questions || [];
  state.awaitingAnswer = { sessionId, questions: qs, callId, mode };
  setSessionId(sessionId);
  updateComposerState();

  const container = el("paused-questions");
  container.innerHTML = "";

  qs.forEach((q, i) => {
    const prefix = qs.length > 1 ? `(${i + 1}/${qs.length}) ` : "";
    const header = q.header ? `[${q.header}] ` : "";
    const questionText = q.question || "";

    const row = document.createElement("div");
    row.className = "paused-q-row";

    const label = document.createElement("span");
    label.className = "paused-q-label";
    label.textContent = prefix + header + questionText;
    if (q.description) label.title = q.description;
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "paused-q-input";
    input.dataset.question = questionText;
    input.placeholder = q.placeholder || "Type your answer...";
    input.oninput = updatePausedSubmitState;

    if (q.type === "choice" && q.options && q.options.length > 0) {
      const isMulti = q.multiSelect === true;
      const selected = new Set();
      const choicesDiv = document.createElement("div");
      choicesDiv.className = "paused-choices";
      const updateMultiAnswer = () => {
        input.value = Array.from(selected).sort((a, b) => a - b).map(n => n + 1).join(",");
        updatePausedSubmitState();
      };

      q.options.forEach((opt, idx) => {
        const btn = document.createElement("button");
        btn.className = "paused-choice-btn";
        btn.textContent = (idx + 1) + ". " + opt.label;
        if (opt.description) btn.title = opt.description;
        btn.onclick = () => {
          if (isMulti) {
            if (selected.has(idx)) {
              selected.delete(idx);
              btn.classList.remove("selected");
            } else {
              selected.add(idx);
              btn.classList.add("selected");
            }
            updateMultiAnswer();
          } else {
            input.value = String(idx + 1);
            row.querySelectorAll(".paused-choice-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            updatePausedSubmitState();
          }
        };
        choicesDiv.appendChild(btn);
      });

      if (isMulti) {
        const submitBtn = document.createElement("button");
        submitBtn.className = "paused-choice-btn";
        submitBtn.textContent = "Confirm";
        submitBtn.onclick = () => {
          updateMultiAnswer();
        };
        choicesDiv.appendChild(submitBtn);
      }

      row.appendChild(choicesDiv);
      input.style.display = "none";
    } else {
      input.onkeydown = (e) => { if (e.key === "Enter") resumeFromPaused(); };
    }

    row.appendChild(input);
    container.appendChild(row);
  });

  el("paused-bar").classList.add("visible");
  updatePausedSubmitState();
  const firstInput = container.querySelector(".paused-q-input");
  if (firstInput) firstInput.focus();
}

async function resumeFromPaused() {
  if (!state.awaitingAnswer) return;
  const { sessionId, mode, questions } = state.awaitingAnswer;

  const answers = {};
  const qInputs = el("paused-questions").querySelectorAll(".paused-q-input");
  let hasAnswer = false;
  qInputs.forEach(input => {
    const q = input.dataset.question || "";
    const v = input.value.trim();
    if (v) {
      answers[q] = v;
      hasAnswer = true;
    }
  });

  if (!hasAnswer) return;

  state.awaitingAnswer = null;
  el("paused-bar").classList.remove("visible");
  el("paused-questions").innerHTML = "";
  updateComposerState();

  appendLine("conv-log", "line-user", "You: " + JSON.stringify(answers));
  appendLine("raw-log", "line-system", "--- continuing paused session ---");

  if (mode === "sync") {
    await continueSync(sessionId, answers);
  } else {
    await continueStream(sessionId, answers);
  }
}

async function continueSync(sessionId, answers) {
  const controller = new AbortController();
  state.abortController = controller;
  setSending(true);
  try {
    const resp = await fetch("/api/chat/sync/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, answers }),
      signal: controller.signal,
    });
    appendJson("raw-log", "line-system", { status: resp.status });
    if (!resp.ok) {
      const err = await resp.json();
      appendLine("conv-log", "line-error", "Error: " + (err.detail || resp.statusText));
      appendJson("raw-log", "line-error", err);
      return;
    }
    const data = await resp.json();
    appendJson("raw-log", "line-system", data);
    if (data.status === "paused") {
      const qs = data.questions || [];
      const labels = qs.map(q => q.question || "").join(", ");
      appendLine("conv-log", "line-paused", "  [Paused] " + labels);
      enterPausedState({ session_id: data.session_id, questions: qs, call_id: data.call_id, mode: "sync" });
      return;
    }
    appendLine("conv-log", "line-assistant", "Assistant: " + data.message);
    if (data.tool_calls && data.tool_calls.length > 0) {
      for (const tc of data.tool_calls) {
        appendLine("conv-log", "line-tool", "  Tool: " + tc.name + "(" + tc.arguments + ") -> " + truncate(tc.result, 200));
        appendJson("tool-log", "line-tool", tc);
      }
    }
    if (data.session_id) setSessionId(data.session_id);
    if (data.usage) {
      appendLine("raw-log", "line-system", "usage: " + JSON.stringify(data.usage));
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      appendLine("conv-log", "line-error", "Error: " + e.message);
    }
  } finally {
    state.abortController = null;
    setSending(false);
  }
}

async function continueStream(sessionId, answers) {
  const controller = new AbortController();
  state.abortController = controller;
  setSending(true);
  let assistantText = "";
  const assistantSpan = document.createElement("span");
  assistantSpan.className = "line-assistant";
  assistantSpan.textContent = "Assistant: ";
  el("conv-log").appendChild(assistantSpan);
  try {
    const resp = await fetch("/api/chat/stream/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, answers }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.text();
      appendLine("conv-log", "line-error", "Error: " + err);
      return;
    }
    await readSseStream(resp, (event) => {
      if (event.type === "delta") {
        const d = JSON.parse(event.data);
        assistantText += d.content;
        assistantSpan.textContent = "Assistant: " + assistantText;
        el("conv-log").scrollTop = el("conv-log").scrollHeight;
      } else if (event.type === "tool_call") {
        const d = JSON.parse(event.data);
        appendLine("conv-log", "line-tool", "  Tool: " + d.name + "(" + d.arguments + ")");
        appendJson("tool-log", "line-tool", d);
      } else if (event.type === "tool_result") {
        const d = JSON.parse(event.data);
        appendLine("conv-log", "line-tool", "  Result: " + truncate(d.result, 200));
        appendJson("tool-log", "line-tool", d);
      } else if (event.type === "paused") {
        const d = JSON.parse(event.data);
        const qs = d.questions || [];
        const labels = qs.map(q => q.question || "").join(", ");
        appendLine("conv-log", "line-paused", "  [Paused] " + labels);
        enterPausedState({ session_id: d.session_id, questions: qs, call_id: d.call_id, mode: "stream" });
      } else if (event.type === "complete") {
        const d = JSON.parse(event.data);
        if (d.session_id) setSessionId(d.session_id);
        if (d.usage) {
          appendLine("raw-log", "line-system", "usage: " + JSON.stringify(d.usage));
        }
      } else if (event.type === "error") {
        const d = JSON.parse(event.data);
        appendLine("conv-log", "line-error", "Error: " + (d.detail || "unknown error"));
      }
      appendLine("raw-log", "line-system", "[" + event.type + "] " + event.data);
    });
  } catch (e) {
    if (e.name !== "AbortError") {
      appendLine("conv-log", "line-error", "Error: " + e.message);
    }
  } finally {
    finishLogLine(assistantSpan);
    state.abortController = null;
    setSending(false);
  }
}

function cancelPaused() {
  state.awaitingAnswer = null;
  el("paused-bar").classList.remove("visible");
  el("paused-questions").innerHTML = "";
  updateComposerState();
}

function stopRequest() {
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
    appendLine("conv-log", "line-system", "[stopped by user]");
    setSending(false);
  }
}

async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";
    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        try {
          JSON.parse(data);
          onEvent({ type: eventType, data });
        } catch (_) {}
        eventType = "";
      }
    }
  }
}

function truncate(s, max) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "..." : s;
}

restore();
(async () => { await fetchAgents(); el("msg-input").focus(); })();
</script>
</body>
</html>
"""
