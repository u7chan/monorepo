import { AUTH_REQUIRED_GUIDE, SANDBOX_REQUIRED_GUIDE, type RuntimeStatus } from "../hooks/runtimeStatus";

export type RuntimeAlertProps = {
  runtimeStatus: RuntimeStatus;
  compact?: boolean;
};

function GuideText({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded bg-raised px-1.5 py-0.5 text-2xs text-ink-soft">
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

export function RuntimeAlert({ runtimeStatus, compact = false }: RuntimeAlertProps) {
  if (!runtimeStatus.error || !runtimeStatus.detail) return null;

  // APIキー / .env の案内は認証エラーのときだけ出す (サンドボックス由来の 503 と混同させない)。
  const guide = runtimeStatus.authRequired
    ? AUTH_REQUIRED_GUIDE
    : runtimeStatus.sandboxRequired
      ? SANDBOX_REQUIRED_GUIDE
      : null;

  return (
    <div
      role="alert"
      className={[
        "flex items-start gap-2.5 border border-danger/35 bg-soft",
        compact ? "rounded-lg px-2.5 py-2 text-1xs" : "rounded-xl px-3.5 py-3 text-1xs",
      ].join(" ")}
    >
      <span className="dot dot-danger mt-1" aria-hidden />
      <div className="min-w-0">
        <strong className="font-semibold text-danger-text">{runtimeStatus.text}</strong>
        <p className={["break-words leading-relaxed text-ink-soft", compact ? "mt-0.5" : "mt-1"].join(" ")}>
          {runtimeStatus.detail}
        </p>
        {guide ? (
          <p className={["break-words leading-relaxed text-ink-muted", compact ? "mt-1" : "mt-2"].join(" ")}>
            <GuideText text={guide} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
