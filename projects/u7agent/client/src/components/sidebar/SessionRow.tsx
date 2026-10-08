import { agentIconOf } from "../../lib/agentIcon";
import { cn } from "../../lib/cn";
import { messageTimeLabel } from "../../lib/messageTime";
import { sessionRowActions, type SessionRowKind } from "../../lib/sidebarRowMenu";
import { sidebarStatus } from "../../lib/sidebarStatus";
import type { AgentDef, SessionSummary } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { BellIcon, PinIcon } from "../icons";
import { RowMenu } from "../RowMenu";

/** 行の選択と ⋯ の操作は別の button にする (入れ子の interactive control を作らない) */
export function SessionRow({
  item,
  agents,
  active,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
}: {
  item: SessionSummary;
  /** アイコンはカタログから live 解決する (定義を編集すると既存セッションの表示も変わる) */
  agents: AgentDef[];
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const status = sidebarStatus(item.status);
  const bits = [
    item.agentName,
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
  ].filter(Boolean);
  // kind から行の props を引く表。actions と同じ種別に狭め、表の無い kind を型で検出する
  const handlers: Record<SessionRowKind, () => void> = { pin: onTogglePin, rename: onRename, delete: onDelete };

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
        {/* 圧縮も「サーバーが動いている」ので実行中と同じ点で示す (区別はラベルが担う) */}
        <span className={cn("dot", status.tone === "live" ? "dot-accent dot-pulse" : "dot-idle")} aria-hidden />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-1">
            {item.pinned ? (
              <span role="img" aria-label="ピン留め中" title="ピン留め中" className="shrink-0 text-accent-text">
                <PinIcon small />
              </span>
            ) : null}
            <strong className="truncate text-xs text-ink">{item.title || "無題のセッション"}</strong>
          </span>
          <small className="flex min-w-0 items-center gap-1 text-2xs text-ink-muted">
            {/* アイコンはエージェント名の隣にだけ置く (名前が無いセッションでは時刻から始める) */}
            {item.agentName ? <AgentIcon icon={agentIconOf(agents, item.agentId)} variant="inline" /> : null}
            <span className="flex-1 truncate">{bits.join(" · ")}</span>
            {/* 状態ラベルは truncate の外に置く (長いエージェント名でも切れない)。
                ラベルは button 内の可視テキストなので、読み上げ名にはそのまま入る */}
            {status.label ? (
              <span className="shrink-0" title={status.label}>
                {status.label}
              </span>
            ) : null}
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
        actions={sessionRowActions(item.pinned === true)}
        onSelect={(kind) => handlers[kind]()}
      />
    </div>
  );
}
