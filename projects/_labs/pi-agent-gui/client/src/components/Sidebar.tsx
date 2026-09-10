import type { AgentDesk } from "../hooks/useAgentDesk";
import type { SessionSummary } from "../types";

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

function SessionRow({
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
    new Date(item.lastUsedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    STATUS_LABELS[item.status],
    item.queueDepth > 0 ? `待機${item.queueDepth}件` : "",
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        "max-nav:flex-none max-nav:basis-[min(220px,calc(100vw-36px))] max-nav:min-h-[42px]",
        active ? "border border-accent/35 bg-accent-wash" : "border border-transparent bg-soft hover:bg-hover",
      ].join(" ")}
    >
      <span className={statusDotClass(item.status)} aria-hidden />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="truncate text-xs text-ink">{item.title || "無題のセッション"}</strong>
        <small className="truncate text-[10px] text-ink-muted">{bits.join(" · ")}</small>
      </span>
      <span
        role="button"
        tabIndex={0}
        title="セッションを削除"
        aria-label="セッションを削除"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
            onDelete();
          }
        }}
        className="cursor-pointer px-1 text-[13px] leading-none text-ink-ghost transition-colors group-hover:text-danger hover:!text-danger max-nav:opacity-100 nav:opacity-0 nav:group-hover:opacity-100"
      >
        ×
      </span>
    </button>
  );
}

export type SidebarProps = Omit<
  Pick<
    AgentDesk,
    | "catalog"
    | "sessions"
    | "sessionId"
    | "agentId"
    | "cwd"
    | "selectedAgent"
    | "newChat"
    | "selectSession"
    | "deleteSession"
  >,
  "newChat" | "selectSession" | "deleteSession"
> & {
  newChat: (agentId?: string) => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  onOpenManager: () => void;
};

export function Sidebar({ onOpenManager, ...props }: SidebarProps) {
  const { catalog, sessions, sessionId, agentId, cwd, selectedAgent, newChat, selectSession, deleteSession } =
    props;

  const assignedSkills = (selectedAgent?.skillIds || [])
    .map((skillId) => catalog.skills.find((skill) => skill.id === skillId))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));

  return (
    <aside
      className={[
        "flex flex-col gap-3.5 bg-panel px-3 py-4",
        "nav:w-[252px] nav:shrink-0 nav:overflow-y-auto nav:border-r nav:border-line",
        "max-nav:flex-row max-nav:flex-wrap max-nav:gap-x-3 max-nav:gap-y-2.5 max-nav:border-b max-nav:border-line max-nav:px-[18px] max-nav:py-3",
      ].join(" ")}
    >
      {/* ブランド */}
      <div className="flex items-center gap-3 max-nav:min-w-0 max-nav:flex-1">
        <div className="grid size-8 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent-wash text-sm text-accent">
          ✦
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-strong">agent desk</div>
          <div className="text-[10px] text-ink-faint">local workspace</div>
        </div>
      </div>

      {/* 新しい会話 */}
      <button
        type="button"
        onClick={() => void newChat()}
        className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-raised text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:text-accent max-nav:w-auto max-nav:px-3.5"
      >
        <span className="text-[18px] leading-3 text-accent">＋</span> 新しい会話
      </button>

      {/* エージェント */}
      <div className="grid gap-2 max-nav:w-full">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">エージェント</div>
        <select
          className="field cursor-pointer text-xs"
          aria-label="エージェントを選択"
          value={agentId}
          disabled={catalog.agents.length === 0}
          onChange={(event) => {
            // 現在の会話は保持しつつ、新しい会話を選択エージェントで開始する
            void newChat(event.currentTarget.value);
          }}
        >
          {catalog.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <div className="min-h-[30px] text-[11px] leading-relaxed text-ink-soft max-nav:hidden">
          {selectedAgent?.description || "エージェントを選択してください"}
        </div>
        <div className="flex flex-wrap gap-1.5 max-nav:hidden">
          {assignedSkills.map((skill) => (
            <span key={skill.id} className="rounded border border-accent/20 bg-accent-wash px-1.5 py-0.5 text-[10px] text-accent-text">
              {skill.name}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onOpenManager}
          className="min-h-9 w-full rounded-lg border border-line bg-transparent text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent"
        >
          ⚙ エージェント / スキルを管理
        </button>
      </div>

      {/* セッション */}
      <div className="grid gap-2 max-nav:w-full">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">セッション</div>
        {sessions.length === 0 ? (
          <div className="rounded-lg px-1 py-1 text-[11px] text-ink-faint max-nav:hidden">セッションはまだありません</div>
        ) : (
          <div className="scrollbar-thin grid max-h-66 gap-1 overflow-y-auto pr-0.5 max-nav:flex max-nav:max-h-none max-nav:overflow-x-auto max-nav:overflow-y-hidden max-nav:pb-0.5 max-nav:[scrollbar-width:none]">
            {sessions.map((item) => (
              <SessionRow
                key={item.sessionId}
                item={item}
                active={item.sessionId === sessionId}
                onSelect={() => {
                  if (item.sessionId !== sessionId) void selectSession(item.sessionId);
                }}
                onDelete={() => void deleteSession(item.sessionId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 作業ディレクトリ + フットノート (モバイルでは非表示) */}
      <div className="mt-auto grid max-nav:hidden" aria-hidden>
        <div className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">作業ディレクトリ</div>
          <code className="truncate text-[11px] leading-normal text-ink-soft">{cwd || "読み込み中…"}</code>
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-ink-ghost">
          ローカル実行 · インメモリセッション
          <br />
          使い捨ての小さな実験アプリ
        </div>
      </div>
    </aside>
  );
}
