import { useState } from "preact/hooks"
import type { HealthState } from "./health"
import { loadHealth } from "./health"
import { healthMessage } from "./message"
import { clearToken, saveToken } from "./token"

export type AppProps = {
  initialToken: string | null
  initialHealth: HealthState | null
}

export function App({ initialToken, initialHealth }: AppProps) {
  const [token, setToken] = useState(initialToken)
  const [health, setHealth] = useState(initialHealth)

  const needsToken = token === null || health?.status === "unauthorized"

  async function submitToken(value: string): Promise<void> {
    const next = await loadHealth(value)
    setHealth(next)

    if (next.status === "ok") {
      saveToken(value)
      setToken(value)

      return
    }

    if (next.status === "unauthorized") {
      clearToken()
      setToken(null)
    }
  }

  async function reloadHealth(): Promise<void> {
    if (token === null) {
      return
    }

    setHealth(await loadHealth(token))
  }

  function resetToken(): void {
    clearToken()
    setToken(null)
    setHealth(null)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">herdr-mobile-client</h1>
        <p className="text-sm text-slate-500">Herdr と Pi を LAN から操作するための PoC</p>
      </header>

      {needsToken ? (
        <TokenForm
          message={health === null || health.status === "ok" ? null : healthMessage(health)}
          onSubmit={submitToken}
        />
      ) : (
        <HealthCard health={health} onReload={reloadHealth} onResetToken={resetToken} />
      )}

      <p className="text-xs text-slate-400">
        ここは土台のみです。Herdr 連携・会話表示は以降のステップで追加します。
      </p>
    </main>
  )
}

function TokenForm({
  message,
  onSubmit,
}: {
  message: string | null
  onSubmit: (value: string) => Promise<void>
}) {
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault()

    if (busy) {
      return
    }

    setBusy(true)

    try {
      await onSubmit(value.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-slate-200 p-4">
      <h2 className="text-xs font-medium tracking-wide text-slate-500 uppercase">トークン</h2>

      <p className="text-sm text-slate-600">
        サーバーの起動ログに出たトークンを入力します。固定値を使う場合はサーバーへ
        <code className="mx-1 rounded bg-slate-100 px-1">HERDR_CLIENT_TOKEN</code>
        を渡します。
      </p>

      {message !== null && <p className="text-sm text-red-600">{message}</p>}

      <label className="block space-y-1">
        <span className="text-xs text-slate-500">トークン</span>
        <input
          type="text"
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </label>

      <button
        type="submit"
        disabled={busy || value.trim() === ""}
        className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:bg-slate-300"
      >
        {busy ? "確認中..." : "このトークンで接続"}
      </button>
    </form>
  )
}

function HealthCard({
  health,
  onReload,
  onResetToken,
}: {
  health: HealthState | null
  onReload: () => Promise<void>
  onResetToken: () => void
}) {
  return (
    <section className="rounded-lg border border-slate-200 p-4">
      <h2 className="text-xs font-medium tracking-wide text-slate-500 uppercase">Bridge</h2>

      {health === null && <p className="mt-2 text-sm text-slate-500">確認中...</p>}

      {health !== null && health.status !== "ok" && (
        <p className="mt-2 text-sm text-red-600">{healthMessage(health)}</p>
      )}

      {health !== null && health.status === "ok" && (
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">状態</dt>
            <dd>{health.health.ok ? "ok" : "ng"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">バージョン</dt>
            <dd>{health.health.version}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">起動時刻</dt>
            <dd>{health.health.startedAt}</dd>
          </div>
        </dl>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onReload}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
        >
          再取得
        </button>
        <button
          type="button"
          onClick={onResetToken}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm"
        >
          トークンを入力し直す
        </button>
      </div>
    </section>
  )
}
