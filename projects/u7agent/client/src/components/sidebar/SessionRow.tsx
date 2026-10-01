import { agentIconOf } from "../../lib/agentIcon";
import { cn } from "../../lib/cn";
import { messageTimeLabel } from "../../lib/messageTime";
import { sidebarStatus, type SeenRuns, type SidebarTone } from "../../lib/sidebarStatus";
import { sessionRowActions, type SessionRowKind } from "../../lib/sidebarRowMenu";
import type { AgentDef, SessionSummary } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { BellIcon } from "../icons";
import { RowMenu } from "../RowMenu";

const DOT_CLASS: Record<SidebarTone, string> = {
  accent: cn("dot dot-accent dot-pulse"),
  ok: cn("dot dot-ok"),
  warn: cn("dot dot-warn"),
  danger: cn("dot dot-danger"),
  idle: cn("dot dot-idle"),
};

/** 行の選択と ⋯ の操作は別の button にする (入れ子の interactive control を作らない) */
export function SessionRow({
  item,
  agents,
  active,
  seenRuns,
  onSelect,
  onRename,
  onDelete,
}: {
  item: SessionSummary;
  /** アイコンはカタログから live 解決する (定義を編集すると既存セッションの表示も変わる) */
  agents: AgentDef[];
  active: boolean;
  /** 既読の run id (会話 id -> run id)。未見の判定はこれだけを正とする */
  seenRuns: SeenRuns;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const bits = [
    item.agentName,
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
  ].filter(Boolean);
  const status = sidebarStatus(item, seenRuns);
  // kind から行の props を引く表。actions と同じ種別に狭め、表の無い kind を型で検出する
  const handlers: Record<SessionRowKind, () => void> = { rename: onRename, delete: onDelete };

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
        <span className={DOT_CLASS[status.tone]} aria-hidden />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="truncate text-xs text-ink">{item.title || "無題のセッション"}</strong>
          <small className="flex min-w-0 items-center gap-1 text-2xs text-ink-muted">
            {/* アイコンはエージェント名の隣にだけ置く (名前が無いセッションでは時刻から始める) */}
            {item.agentName ? <AgentIcon icon={agentIconOf(agents, item.agentId)} variant="inline" /> : null}
            <span className="truncate">{bits.join(" · ")}</span>
            {/* 状態ラベルは truncate の外に固定する (長いエージェント名で未見のラベルが切れないように) */}
            {status.label ? <span className="shrink-0">{status.label}</span> : null}
          </small>
        </span>
      </button>
      {/* 通知が On の会話だけ鳴っているベルを出す (Off は印を出さず、一覧が記号で埋まらないようにする) */}
      {item.notify ? (
        <span role="img" aria-label="通知オン" title="通知オン" className="shrink-0 text-accent-text">
          <BellIcon ringing />
        </span>
      ) : null}
      <RowMenu
        name={item.title || "無題のセッション"}
        actions={sessionRowActions()}
        onSelect={(kind) => handlers[kind]()}
      />
    </div>
  );
}
