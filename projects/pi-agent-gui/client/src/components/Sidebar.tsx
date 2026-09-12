import { ThemeSwitcher } from "../theme/ThemeSwitcher";
import type { AgentDesk } from "../hooks/useAgentDesk";
import { messageTimeLabel } from "../lib/messageTime";
import type { SessionSummary } from "../types";
import { CloseIcon } from "./icons";

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
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
    STATUS_LABELS[item.status],
    item.queueDepth > 0 ? `待機${item.queueDepth}件` : "",
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        "min-h-[42px]",
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
        // タッチ端末では常時表示する (ChatArea のコピーボタンと同じ can-hover の使い方)
        className="cursor-pointer px-1 text-[13px] leading-none text-ink-ghost transition-colors group-hover:text-danger hover:!text-danger can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100"
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
  /** sheet variant のときだけ使う (モバイルのドロワーを閉じる) */
  onClose?: () => void;
  /** sidebar: desktop の左カラム / sheet: モバイルのドロワー内 */
  variant?: "sidebar" | "sheet";
};

export function Sidebar({ onOpenManager, onClose, variant = "sidebar", ...props }: SidebarProps) {
  const sheet = variant === "sheet";
  const { catalog, sessions, sessionId, agentId, cwd, selectedAgent, newChat, selectSession, deleteSession } =
    props;

  const assignedSkills = (selectedAgent?.skillIds || [])
    .map((skillId) => catalog.skills.find((skill) => skill.id === skillId))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));

  return (
    <aside
      className={[
        "flex h-full min-h-0 flex-col gap-3.5 bg-panel px-3 py-4",
        // 高さが足りない compact では drawer 全体を 1 つのスクロール領域にする。
        // 一覧だけを flex-1 にすると固定部分だけで高さを使い切り、一覧が 0px に潰れる
        "overflow-y-auto",
        sheet ? null : "border-r border-line",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* ブランド */}
      <div className="flex items-center gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent-wash text-sm text-accent-strong">
          ✦
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink-strong">agent desk</div>
          <div className="text-[10px] text-ink-faint">local workspace</div>
        </div>
        {sheet && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="ナビゲーションを閉じる"
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>

      {/* 新しい会話 */}
      <button
        type="button"
        onClick={() => newChat()}
        className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-raised text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:text-accent-text"
      >
        <span className="text-[18px] leading-3 text-accent-text">＋</span> 新しい会話
      </button>

      {/* エージェント */}
      <div className="grid gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">エージェント</div>
        <select
          className={["field cursor-pointer", sheet ? "text-[16px]" : "text-xs"].join(" ")}
          aria-label="エージェントを選択"
          value={agentId}
          disabled={catalog.agents.length === 0}
          onChange={(event) => {
            // 現在の会話は保持しつつ、新しい会話を選択エージェントで開始する
            newChat(event.currentTarget.value);
          }}
        >
          {catalog.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        {/* 説明とスキルは drawer では畳む (agent の詳細は管理画面で見る) */}
        {sheet ? null : (
          <>
            <div className="min-h-[30px] text-[11px] leading-relaxed text-ink-soft">
              {selectedAgent?.description || "エージェントを選択してください"}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {assignedSkills.map((skill) => (
                <span key={skill.id} className="rounded border border-accent/20 bg-accent-wash px-1.5 py-0.5 text-[10px] text-accent-text">
                  {skill.name}
                </span>
              ))}
            </div>
          </>
        )}
        <button
          type="button"
          onClick={onOpenManager}
          className="min-h-9 w-full rounded-lg border border-line bg-transparent text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
        >
          ⚙ エージェント / スキルを管理
        </button>
      </div>

      {/* セッション */}
      <div className="grid gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">セッション</div>
        {sessions.length === 0 ? (
          <div className="rounded-lg px-1 py-1 text-[11px] text-ink-faint">セッションはまだありません</div>
        ) : (
          <div
            className={[
              "scrollbar-thin grid gap-1 pr-0.5",
              // desktop の sidebar は高さが固定されるので、一覧だけ独立スクロールにする
              sheet ? null : "max-h-66 overflow-y-auto",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {sessions.map((item) => (
              <SessionRow
                key={item.sessionId}
                item={item}
                active={item.sessionId === sessionId}
                onSelect={() => {
                  // 選択中の行かどうかは呼び出し側が判断する (drawer は選択済みでも閉じる)
                  void selectSession(item.sessionId);
                }}
                onDelete={() => void deleteSession(item.sessionId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 作業ディレクトリ + テーマ (sheet のみ) + フットノート */}
      <div className="mt-auto grid gap-2">
        <div className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">作業ディレクトリ</div>
          <code className="truncate text-[11px] leading-normal text-ink-soft">{cwd || "読み込み中…"}</code>
        </div>
        {/* テーマ切替の入口は desktop の Topbar にしかないため、drawer にも置く */}
        {sheet ? (
          <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-3 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">テーマ</div>
            <ThemeSwitcher compact />
          </div>
        ) : null}
        <div className="text-[10px] leading-relaxed text-ink-ghost">
          ローカル実行 · インメモリセッション
          <br />
          pi SDK の小さなブラウザ GUI
        </div>
      </div>
    </aside>
  );
}
