import type { HealthState } from "./health"

export function App({ health }: { health: HealthState }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">herdr-mobile-client</h1>
        <p className="text-sm text-slate-500">Herdr と Pi を LAN から操作するための PoC</p>
      </header>

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="text-xs font-medium tracking-wide text-slate-500 uppercase">Bridge</h2>

        {health.status === "error" && (
          <p className="mt-2 text-sm text-red-600">接続できません: {health.message}</p>
        )}

        {health.status === "ok" && (
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
      </section>

      <p className="text-xs text-slate-400">
        ここは土台のみです。認証・Herdr 連携・会話表示は以降のステップで追加します。
      </p>
    </main>
  )
}
