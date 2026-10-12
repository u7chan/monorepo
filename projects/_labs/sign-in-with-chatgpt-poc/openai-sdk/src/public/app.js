const state = {
  status: null,
  models: [],
  history: [],
  controller: null,
  streaming: false,
  liveContent: null,
}

const REASON_MESSAGES = {
  state_mismatch: "state が一致しません（認可をやり直した可能性があります）。",
  expired: "認可の有効期限が切れています。もう一度サインインしてください。",
  missing_code: "コールバックに認可コードがありません。",
  missing_issued_client_id:
    "コールバックに発行済みの client_id が無く、登録が完了しませんでした。もう一度サインインしてください。",
  client_id_mismatch:
    "コールバックの client_id が保存済みの登録と違うため、上書きしませんでした。",
  access_denied: "同意が拒否されました。",
}

function byId(id) {
  const node = document.getElementById(id)
  if (!node) {
    throw new Error(`#${id} が見つかりません`)
  }
  return node
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue
    }
    if (key === "text") {
      node.textContent = String(value)
      continue
    }
    if (key === "class") {
      node.className = String(value)
      continue
    }
    node.setAttribute(key, value === true ? "" : String(value))
  }
  for (const child of children) {
    node.append(child)
  }
  return node
}

function detailList(entries) {
  const list = el("dl", { class: "detail" })
  for (const [label, value] of entries) {
    list.append(el("dt", { text: label }), el("dd", { text: value }))
  }
  return list
}

async function fetchJson(path, init) {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw (
      body?.error ?? {
        message: `HTTP ${response.status}`,
        status: response.status,
      }
    )
  }
  return body
}

function showBanner(message, kind) {
  const banner = byId("banner")
  banner.textContent = message
  banner.className = kind === "error" ? "banner error" : "banner"
  banner.hidden = false
}

function hideBanner() {
  byId("banner").hidden = true
}

function formatExpiry(seconds) {
  if (seconds === null || seconds === undefined) {
    return "-"
  }
  if (seconds <= 0) {
    return "期限切れ（次のリクエストで更新）"
  }
  return `あと ${Math.floor(seconds / 60)} 分`
}

function renderConnection() {
  const body = byId("connection-body")
  body.textContent = ""
  body.className = ""

  const status = state.status
  if (!status) {
    body.append(
      el("p", { class: "loading", text: "状態を取得できませんでした。" }),
    )
    return
  }

  const actions = el("div", { class: "actions" })

  if (!status.signedIn) {
    body.append(el("p", { class: "connection-headline", text: "未サインイン" }))
    if (status.clientId) {
      body.append(
        el("p", {
          class: "loading",
          text: "保存済みの登録があるため、同じ client ID で再認可します。",
        }),
        detailList([
          ["email", status.email ?? "-"],
          ["client ID", status.clientId],
          ["host ID", status.extAgentHostId],
        ]),
      )
    }
    actions.append(
      el("a", {
        class: "button primary",
        href: "/auth/start",
        text: "Continue with ChatGPT",
      }),
    )
    body.append(
      actions,
      el("p", {
        class: "loading",
        text: "ChatGPT Plus または Pro アカウントで動作を確認します。",
      }),
    )
    byId("chat-card").hidden = true
    return
  }

  body.append(
    el("p", {
      class: "connection-headline",
      text: `サインイン済み: ${status.email ?? "(email なし)"}`,
    }),
  )
  body.append(
    detailList([
      [
        "ChatGPT プラン利用",
        status.planUsageEnabled ? "有効" : "無効（スコープ未付与）",
      ],
      ["アクセストークン", formatExpiry(status.expiresInSeconds)],
      ["有効期限", status.expiresAt ?? "-"],
      ["スコープ", status.scopes.join(" ") || "-"],
      ["subject", status.subject ?? "-"],
      ["client ID", status.clientId ?? "-"],
      ["host ID", status.extAgentHostId],
      ["保存先", status.storageFile],
    ]),
  )

  const refreshButton = el("button", {
    type: "button",
    text: "アクセストークンを更新",
  })
  refreshButton.addEventListener("click", () => {
    void runAction("/api/auth/refresh", "アクセストークンを更新しました。")
  })
  const logoutButton = el("button", { type: "button", text: "サインアウト" })
  logoutButton.addEventListener("click", () => {
    void runAction("/api/auth/logout", "サインアウトしました。")
  })

  actions.append(
    refreshButton,
    el("a", { class: "button", href: "/auth/start", text: "再認可" }),
    el("a", {
      class: "button",
      href: "/auth/start?prompt=consent",
      text: "同意をやり直す",
    }),
    logoutButton,
    el("a", {
      class: "button",
      href: "https://chatgpt.com/settings/usage",
      target: "_blank",
      rel: "noreferrer",
      text: "ChatGPT 設定の使用量",
    }),
  )

  if (!status.planUsageEnabled) {
    body.append(
      el("p", {
        class: "hint",
        text: "ChatGPT プラン利用のスコープが付与されていません。[同意をやり直す] で同意画面を再表示できます。",
      }),
    )
  }

  if (status.debugActionsEnabled) {
    const debugActions = el("div", { class: "actions" })
    const expireButton = el("button", {
      type: "button",
      text: "アクセストークンを期限切れにする",
    })
    expireButton.addEventListener("click", () => {
      void runAction(
        "/api/debug/expire-access-token",
        "アクセストークンを期限切れにしました。",
      )
    })
    const invalidateButton = el("button", {
      type: "button",
      text: "アクセストークンを偽物にする",
    })
    invalidateButton.addEventListener("click", () => {
      void runAction(
        "/api/debug/invalidate-access-token",
        "アクセストークンを偽物にしました。",
      )
    })
    debugActions.append(expireButton, invalidateButton)
    body.append(
      el("p", {
        class: "debug-label",
        text: "デバッグ操作（SIWC_ENABLE_DEBUG_ACTIONS=false で無効化）",
      }),
      debugActions,
    )
    byId("debug-row").hidden = false
  }

  body.append(actions)
  byId("chat-card").hidden = false
}

async function runAction(path, successMessage) {
  const description = byId("chat-status")
  description.textContent = "実行中…"
  try {
    const result = await fetchJson(path, { method: "POST" })
    const warning = result?.warning ? ` ${result.warning}` : ""
    description.textContent = `${successMessage}${warning}`
    hideBanner()
  } catch (error) {
    description.textContent = ""
    showBanner(`失敗しました: ${error.message ?? error}`, "error")
  }
  await refreshStatus()
}

async function loadModels() {
  try {
    const result = await fetchJson("/api/models")
    state.models = result.models
  } catch (error) {
    state.models = []
    setChatStatus(
      `モデル一覧の取得に失敗: ${error.message ?? error}${error.hint ? `\n${error.hint}` : ""}`,
    )
  }

  const defaultModel = state.status?.defaultModel ?? ""
  const catalogHasDefault = state.models.some(
    (model) => model.slug === defaultModel,
  )
  const options =
    defaultModel !== "" && !catalogHasDefault
      ? [
          { slug: defaultModel, displayName: defaultModel, missing: true },
          ...state.models,
        ]
      : state.models

  const select = byId("model-select")
  select.textContent = ""
  if (options.length === 0) {
    select.append(el("option", { value: "", text: "(モデルなし)" }))
    return
  }
  for (const model of options) {
    const label =
      model.displayName === model.slug
        ? model.slug
        : `${model.displayName} (${model.slug})`
    select.append(
      el("option", {
        value: model.slug,
        text: model.missing ? `${label} ※カタログに無し` : label,
      }),
    )
  }
  if (defaultModel !== "") {
    select.value = defaultModel
  }
  if (defaultModel !== "" && !catalogHasDefault) {
    setChatStatus(
      `既定モデル ${defaultModel} はこのアカウントのカタログにありません。そのまま選択しているので、送信すると実際の可否が分かります。`,
    )
  }
}

function renderTranscript() {
  const transcript = byId("transcript")
  transcript.textContent = ""
  state.liveContent = null
  for (const message of state.history) {
    const bubble = el(
      "div",
      { class: `message ${message.role}` },
      el("div", { class: "role", text: message.role }),
    )
    bubble.append(el("div", { class: "content", text: message.content }))
    transcript.append(bubble)
  }
  transcript.scrollTop = transcript.scrollHeight
}

function appendAssistantBubble() {
  const transcript = byId("transcript")
  const bubble = el(
    "div",
    { class: "message assistant" },
    el("div", { class: "role", text: "assistant" }),
  )
  const content = el("div", { class: "content" })
  bubble.append(content)
  transcript.append(bubble)
  transcript.scrollTop = transcript.scrollHeight
  state.liveContent = content
}

function appendDelta(text) {
  if (!state.liveContent) {
    appendAssistantBubble()
  }
  state.liveContent.textContent += text
  const transcript = byId("transcript")
  transcript.scrollTop = transcript.scrollHeight
}

function setChatStatus(text) {
  byId("chat-status").textContent = text
}

function showChatError(error) {
  const parts = [
    `${error.status ?? "-"} ${error.code ?? "-"}: ${error.message ?? "不明なエラー"}`,
  ]
  if (error.param) {
    parts.push(`param: ${error.param}`)
  }
  if (error.requestId) {
    parts.push(`request ID: ${error.requestId}`)
  }
  if (error.hint) {
    parts.push(error.hint)
  }
  setChatStatus(parts.join("\n"))
}

function setStreaming(streaming) {
  state.streaming = streaming
  byId("send").disabled = streaming
  byId("cancel").disabled = !streaming
}

async function sendMessage() {
  if (state.streaming) {
    return
  }
  const prompt = byId("prompt").value.trim()
  if (prompt === "") {
    return
  }
  const model = byId("model-select").value
  if (model === "") {
    setChatStatus("モデルを選択してください。")
    return
  }

  const payload = {
    model,
    instructions: byId("instructions").value,
    input: [...state.history, { role: "user", content: prompt }],
  }
  if (byId("unsupported-temperature").checked) {
    payload.temperature = 0
  }

  state.history.push({ role: "user", content: prompt })
  byId("prompt").value = ""
  renderTranscript()
  appendAssistantBubble()
  setStreaming(true)
  setChatStatus("ストリーム待機中…")

  state.controller = new AbortController()
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw (
        body?.error ?? {
          message: `HTTP ${response.status}`,
          status: response.status,
        }
      )
    }
    await readEventStream(response)
  } catch (error) {
    if (error.name === "AbortError") {
      setChatStatus("中断しました。")
    } else {
      showChatError(error)
    }
  } finally {
    state.controller = null
    setStreaming(false)
    renderTranscript()
  }
}

async function readEventStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let separator = buffer.indexOf("\n\n")
    while (separator >= 0) {
      const block = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      handleEvent(parseSseBlock(block))
      separator = buffer.indexOf("\n\n")
    }
  }
}

function parseSseBlock(block) {
  const event = { name: "message", data: null }
  const dataLines = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event.name = line.slice("event:".length).trim()
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }
  if (dataLines.length > 0) {
    try {
      event.data = JSON.parse(dataLines.join("\n"))
    } catch {
      event.data = null
    }
  }
  return event
}

function handleEvent(event) {
  const data = event.data
  switch (event.name) {
    case "token":
      setChatStatus(
        `アクセストークンを自動更新しました（新しい期限: ${data?.expiresAt ?? "-"}）`,
      )
      break
    case "response":
      setChatStatus(`request 開始: response ID ${data?.responseId ?? "-"}`)
      break
    case "delta":
      appendDelta(data?.text ?? "")
      break
    case "completed": {
      const text = state.liveContent?.textContent ?? ""
      if (text !== "") {
        state.history.push({ role: "assistant", content: text })
      }
      setChatStatus(`completed: response ID ${data?.responseId ?? "-"}`)
      break
    }
    case "incomplete":
      setChatStatus(`incomplete: ${data?.reason ?? "reason 不明"}`)
      break
    case "failed":
      showChatError(data?.error ?? { message: "response.failed" })
      break
    default:
      break
  }
}

async function refreshStatus() {
  try {
    state.status = await fetchJson("/api/status")
  } catch (error) {
    showBanner(`状態を取得できませんでした: ${error.message ?? error}`, "error")
    return
  }
  if (!state.status.signedIn) {
    state.history = []
    renderTranscript()
  }
  renderConnection()
  if (state.status.signedIn) {
    await loadModels()
  }
}

function handleQueryParameters() {
  const params = new URLSearchParams(window.location.search)
  const auth = params.get("auth")
  if (auth === "signed-in") {
    showBanner("サインインしました。", "info")
  } else if (auth === "error") {
    const reason = params.get("reason") ?? "unknown"
    showBanner(
      `サインインに失敗しました: ${REASON_MESSAGES[reason] ?? reason}`,
      "error",
    )
  }
  if (auth !== null) {
    window.history.replaceState(null, "", "/")
  }
}

byId("chat-form").addEventListener("submit", (event) => {
  event.preventDefault()
  void sendMessage()
})
byId("prompt").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault()
    void sendMessage()
  }
})
byId("cancel").addEventListener("click", () => {
  state.controller?.abort()
})
byId("reload-models").addEventListener("click", () => {
  void loadModels()
})

handleQueryParameters()
void refreshStatus()
