import type { RuntimeStatus } from "../hooks/useAgentDesk";

export type RuntimeAlertProps = {
  runtimeStatus: RuntimeStatus;
  /** モバイルの compact bar 用に一回り小さくする */
  compact?: boolean;
};

/** ランタイムのエラー詳細 (APIキー未設定など)。error のときだけ描画する。 */
export function RuntimeAlert({ runtimeStatus, compact = false }: RuntimeAlertProps) {
  if (!runtimeStatus.error || !runtimeStatus.detail) return null;

  return (
    <div
      role="alert"
      className={[
        "flex items-start gap-2.5 border border-danger/35 bg-soft",
        compact ? "rounded-lg px-2.5 py-2 text-[11px]" : "rounded-xl px-3.5 py-3 text-[11px]",
      ].join(" ")}
    >
      <span className="dot dot-danger mt-1" aria-hidden />
      <div className="min-w-0">
        <strong className="font-semibold text-danger-text">{runtimeStatus.text}</strong>
        <p className={["break-words leading-relaxed text-ink-soft", compact ? "mt-0.5" : "mt-1"].join(" ")}>
          {runtimeStatus.detail}
        </p>
        {runtimeStatus.authRequired ? (
          <p className={["break-words leading-relaxed text-ink-muted", compact ? "mt-1" : "mt-2"].join(" ")}>
            <code className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-soft">cp .env.example .env</code>
            <span className="ml-1">で設定ファイルを作成し、APIキーを入力してからサーバーを再起動してください。</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
