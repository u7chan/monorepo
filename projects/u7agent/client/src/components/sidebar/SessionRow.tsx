import { agentIconOf } from "../../lib/agentIcon";
import { cn } from "../../lib/cn";
import { messageTimeLabel } from "../../lib/messageTime";
import type { AgentDef, SessionSummary } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { TrashIcon } from "../icons";
import { RowAction } from "./RowAction";

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
      return cn("dot dot-accent dot-pulse");
    case "queued":
    case "stopped":
      return cn("dot dot-warn");
    case "error":
      return cn("dot dot-danger");
    case "completed":
      return cn("dot dot-ok");
    default:
      return cn("dot dot-idle");
  }
}

/** 行の選択と削除は別の button にする (入れ子の interactive control を作らない) */
export function SessionRow({
  item,
  agents,
  active,
  onSelect,
  onDelete,
}: {
  item: SessionSummary;
  /** アイコンはカタログから live 解決する (定義を編集すると既存セッションの表示も変わる) */
  agents: AgentDef[];
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
      className={cn(
        "group flex min-h-10.5 items-center gap-1 rounded-lg border pr-1.5 transition-colors",
        active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
      )}
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
          <small className="flex min-w-0 items-center gap-1 text-2xs text-ink-muted">
            {/* アイコンはエージェント名の隣にだけ置く (名前が無いセッションでは時刻から始める) */}
            {item.agentName ? <AgentIcon icon={agentIconOf(agents, item.agentId)} variant="inline" /> : null}
            <span className="truncate">{bits.join(" · ")}</span>
          </small>
        </span>
      </button>
      <RowAction label="セッションを削除" onClick={onDelete} hoverOnly danger>
        <TrashIcon />
      </RowAction>
    </div>
  );
}
