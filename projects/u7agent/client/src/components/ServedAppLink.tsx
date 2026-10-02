import { cn } from "../lib/cn";
import { servedAppUrl } from "../lib/servedApp";
import { ExternalLinkIcon } from "./icons";

export function ServedAppLink({ port, compact = false }: { port?: number; compact?: boolean }) {
  const href = servedAppUrl(typeof location === "undefined" ? "" : location.hostname, port);
  const label = "serveした成果物を開く";
  const className = cn(
    compact ? "icon-button" : "btn-quiet shrink-0",
    "disabled:cursor-not-allowed disabled:opacity-45",
  );
  const content = (
    <>
      <ExternalLinkIcon />
      {compact ? null : "成果物"}
    </>
  );
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      title="全会話で共有のserve先を開きます。サーバーの起動・停止は行いません"
      className={className}
    >
      {content}
    </a>
  ) : (
    <button
      type="button"
      disabled
      aria-label={label}
      title="成果物の公開ポートを取得できていません"
      className={className}
    >
      {content}
    </button>
  );
}
