import { splitByPinned } from "../../lib/sessionsByProject";
import type { AgentDef, SessionSummary } from "../../types";
import { SessionRow } from "./SessionRow";

/**
 * 1 つの一覧 (Chats / プロジェクト配下) のセッション行。並び順はピン留めが先なので、
 * ピン留めのかたまりを小見出しと区切り線で他と分ける (行のピンのアイコンだけでは境目が読めない)。
 */
export function SessionList({
  sessions,
  agents,
  sessionId,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
}: {
  sessions: SessionSummary[];
  agents: AgentDef[];
  sessionId: string;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
}) {
  const { pinned, rest } = splitByPinned(sessions);

  const renderRow = (item: SessionSummary) => (
    <SessionRow
      key={item.sessionId}
      item={item}
      agents={agents}
      active={item.sessionId === sessionId}
      onSelect={() => onSelect(item.sessionId)}
      onRename={() => onRename(item.sessionId)}
      onDelete={() => onDelete(item.sessionId)}
      onTogglePin={() => onTogglePin(item.sessionId)}
    />
  );

  return (
    <div className="grid gap-1">
      {/* 見出しは装飾。ピン留め中かどうかは行の読み上げ名 (role="img" の「ピン留め中」) が伝える */}
      {pinned.length > 0 ? (
        <div
          className="mt-0.5 flex items-center gap-1.5 px-1.5 text-3xs font-semibold tracking-label text-ink-faint uppercase"
          aria-hidden
        >
          ピン留め
        </div>
      ) : null}
      {pinned.map(renderRow)}
      {pinned.length > 0 && rest.length > 0 ? <div className="my-0.5 border-t border-line" aria-hidden /> : null}
      {rest.map(renderRow)}
    </div>
  );
}
