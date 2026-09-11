import { ThemeSwitcher } from "../theme/ThemeSwitcher";
import type { RuntimeStatus } from "../hooks/useAgentDesk";
import type { ModelDisplay } from "../hooks/modelDisplay";

export type TopbarProps = {
  runtimeStatus: RuntimeStatus;
  /** 表示中のモデル (選択中セッションの実効値 or アプリ既定)。出所はラベルで示す */
  modelDisplay?: ModelDisplay;
};

export function Topbar({ runtimeStatus, modelDisplay }: TopbarProps) {
  // 接続状態ピルは、モデル表示で代替できないとき (エラー / モデル未確定) だけ出す。
  const showStatus = runtimeStatus.error || !modelDisplay;
  return (
    <header className="grid gap-3 px-6 pb-3 pt-5 max-nav:px-[18px] wide:px-8 wide:pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">LOCAL WORKSPACE</div>
          <h1 className="mt-0.5 truncate text-lg font-semibold text-ink-strong max-nav:text-base">
            何を手伝いましょうか？
          </h1>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ThemeSwitcher />
          <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
            {modelDisplay ? (
              <div
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-[11px] text-ink-soft"
                title={`${modelDisplay.label}: ${modelDisplay.model}`}
              >
                <span className="shrink-0 text-ink-ghost">{modelDisplay.label}</span>
                <span className="min-w-0 truncate">{modelDisplay.model}</span>
              </div>
            ) : null}
            {showStatus ? (
              <div
                className={[
                  "inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11px]",
                  runtimeStatus.error ? "border-danger/40 text-danger-text" : "border-line text-ink-soft",
                ].join(" ")}
              >
                <span className={runtimeStatus.error ? "dot dot-danger" : "dot dot-accent"} aria-hidden />
                <span className="min-w-0 truncate">{runtimeStatus.text}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {runtimeStatus.error && runtimeStatus.detail ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-danger/35 bg-soft px-3.5 py-3 text-[11px]"
        >
          <span className="dot dot-danger mt-1" aria-hidden />
          <div className="min-w-0">
            <strong className="font-semibold text-danger-text">{runtimeStatus.text}</strong>
            <p className="mt-1 break-words leading-relaxed text-ink-soft">{runtimeStatus.detail}</p>
            {runtimeStatus.authRequired ? (
              <p className="mt-2 break-words leading-relaxed text-ink-muted">
                <code className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-soft">cp .env.example .env</code>
                <span className="ml-1">で設定ファイルを作成し、APIキーを入力してからサーバーを再起動してください。</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
