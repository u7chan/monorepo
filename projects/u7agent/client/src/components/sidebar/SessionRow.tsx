import { agentIconOf } from "../../lib/agentIcon";
import { cn } from "../../lib/cn";
import { messageTimeLabel } from "../../lib/messageTime";
import { sessionRowActions, type SessionRowKind } from "../../lib/sidebarRowMenu";
import { sidebarStatus, type SidebarStatus } from "../../lib/sidebarStatus";
import type { AgentDef, SessionSummary } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { BellIcon, PinIcon } from "../icons";
import { RowMenu } from "../RowMenu";

const DOT_TONE: Record<SidebarStatus["tone"], string> = {
  live: cn("dot-accent dot-pulse"),
  // 回答待ちは「サーバーが作業している」のではなく「利用者を待っている」ので、静止の warn で示す
  waiting: cn("dot-warn"),
  idle: cn("dot-idle"),
};

/** バッジの色は serve-badge-* に倣う。上下の余白を持たず、2 行目の高さと折り返しを変えない */
const LABEL_TONE: Record<SidebarStatus["tone"], string> = {
  live: cn("border-accent/40 bg-accent/10 text-accent-text"),
  waiting: cn("border-warn/40 bg-warn/10 text-warn"),
  idle: "",
};

/** 行の選択と ⋯ の操作は別の button にする (入れ子の interactive control を作らない) */
export function SessionRow({
  item,
  agents,
  active,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onMove,
}: {
  item: SessionSummary;
  /** アイコンはカタログから live 解決する (定義を編集すると既存セッションの表示も変わる) */
  agents: AgentDef[];
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  /** 未指定の呼び出し側 (プロジェクト配下の一覧) には引っ越しの項目を出さない */
  onMove?: () => void;
}) {
  const status = sidebarStatus(item.status, item.awaitingAnswer === true);
  const bits = [
    item.agentName,
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
  ].filter(Boolean);
  // kind から行の props を引く表。actions と同じ種別に狭め、表の無い kind を型で検出する
  const handlers: Record<SessionRowKind, (() => void) | undefined> = {
    pin: onTogglePin,
    rename: onRename,
    move: onMove,
    delete: onDelete,
  };

  return (
    <div className="grid">
      <div
        className={cn(
          "group flex min-h-10.5 items-center gap-1 rounded-lg border pr-1.5 transition-colors singleColumn:min-h-11",
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
          <span className={cn("dot", DOT_TONE[status.tone])} aria-hidden />
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
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-1.5 leading-none whitespace-nowrap",
                    LABEL_TONE[status.tone],
                  )}
                  title={status.label}
                >
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
          // 引っ越しは canMove (旧サーバーは省略 = false) と操作の受け取りが揃った行だけに出す
          actions={sessionRowActions({
            pinned: item.pinned === true,
            canMove: item.canMove === true && onMove !== undefined,
          })}
          onSelect={(kind) => handlers[kind]?.()}
        />
      </div>
    </div>
  );
}
