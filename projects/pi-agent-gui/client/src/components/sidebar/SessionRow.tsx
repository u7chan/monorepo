import { messageTimeLabel } from "../../lib/messageTime";
import type { SessionSummary } from "../../types";

const STATUS_LABELS: Record<string, string> = {
  running: "実行中",
  queued: "キュー待ち",
  completed: "完了",
  stopped: "停止",
  error: "エラー",
  idle: "",
};

function statusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "dot dot-accent dot-pulse";
    case "queued":
    case "stopped":
      return "dot dot-warn";
    case "error":
      return "dot dot-danger";
    case "completed":
      return "dot dot-ok";
    default:
      return "dot dot-idle";
  }
}

/** 行の選択と削除は別の button にする (入れ子の interactive control を作らない) */
export function SessionRow({
  item,
  active,
  onSelect,
  onDelete,
}: {
  item: SessionSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const bits = [
    item.agentName,
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
    STATUS_LABELS[item.status],
    item.queueDepth > 0 ? `待機${item.queueDepth}件` : "",
  ].filter(Boolean);

  return (
    <div
      className={[
        "group flex min-h-10.5 items-center gap-1 rounded-lg border pr-1.5 transition-colors",
        active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <span className={statusDotClass(item.status)} aria-hidden />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="truncate text-xs text-ink">{item.title || "無題のセッション"}</strong>
          <small className="truncate text-2xs text-ink-muted">{bits.join(" · ")}</small>
        </span>
      </button>
      <button
        type="button"
        title="セッションを削除"
        aria-label="セッションを削除"
        onClick={onDelete}
        // タッチ端末では常時表示する
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-1sm leading-none text-ink-ghost transition-colors group-hover:text-danger hover:bg-danger/20 hover:text-danger can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
