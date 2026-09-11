import { useEffect, useRef } from "react";
import type { Bubble, ToolCard } from "../hooks/chatReducer";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { toolCallCopyText } from "../lib/copy-content";

const SUGGESTIONS = [
  { prompt: "このプロジェクトの構成を簡単に教えて", label: "プロジェクトを説明して" },
  { prompt: "まずテストがあるか確認して", label: "テストを確認して" },
  { prompt: "README を読んで改善案を3つ出して", label: "README をレビューして" },
];

const TOOL_SUMMARY_MAX_LENGTH = 96;

function abbreviatedToolSummary(card: ToolCard): string {
  const summary = `${card.name}${card.args ? ` — ${card.args}` : ""}`.replace(/\s+/g, " ").trim();
  if (summary.length <= TOOL_SUMMARY_MAX_LENGTH) return summary || "ツール";
  return `${summary.slice(0, TOOL_SUMMARY_MAX_LENGTH - 1)}…`;
}

function phaseLabel(phase: ToolCard["phase"]): string {
  return phase === "running" ? "実行中" : phase === "failed" ? "エラー" : "完了";
}

function phaseColor(phase: ToolCard["phase"]): string {
  return phase === "done" ? "text-ink-faint" : phase === "failed" ? "text-danger-text" : "text-accent-text";
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M3.5 8.5 6.75 11.5 12.5 4.75" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <circle cx="8" cy="5.25" r="2.75" />
      <path d="M2.75 13.5c.9-2.35 2.85-3.75 5.25-3.75s4.35 1.4 5.25 3.75" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="tool-disclosure size-3 shrink-0"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** コピー直後は copied 表示を優先し、それ以外は reveal でホバー時に出す */
function CopyButton({ copied, onClick, label, reveal }: { copied: boolean; onClick: () => void; label: string; reveal: string }) {
  return (
    <button
      type="button"
      aria-label={copied ? "コピーしました" : label}
      title={copied ? "コピーしました" : label}
      onClick={onClick}
      className={[
        "grid size-6 shrink-0 place-items-center rounded-md border transition-[opacity,border-color,color] duration-200",
        copied
          ? "border-ok/40 text-ok opacity-100"
          : ["border-line bg-raised text-ink-faint hover:border-accent/50 hover:text-accent", reveal].join(" "),
      ].join(" ")}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** ホバー可能なデバイスのみホバー / フォーカスで出す。タッチ端末は常に表示する */
const REVEAL_MESSAGE = "can-hover:opacity-0 can-hover:group-hover/bubble:opacity-100 focus-visible:opacity-100";
const REVEAL_TOOL = "can-hover:opacity-0 can-hover:group-hover/row:opacity-100 focus-visible:opacity-100";

function historyPhase(cards: ToolCard[]): ToolCard["phase"] {
  if (cards.some((card) => card.phase === "running")) return "running";
  if (cards.some((card) => card.phase === "failed")) return "failed";
  return "done";
}

function historyPreview(cards: ToolCard[]): string {
  if (cards.length === 1) return abbreviatedToolSummary(cards[0]);
  const names = cards.slice(0, 3).map((card) => card.name || "ツール");
  const remainder = cards.length > names.length ? ` ほか${cards.length - names.length}件` : "";
  return `${names.join(" / ")}${remainder}`;
}

function ToolCallRow({ card, index, copied, onCopy }: { card: ToolCard; index: number; copied: boolean; onCopy: () => void }) {
  return (
    <li className={["group/row min-w-0 py-2.5", index > 0 ? "border-t border-line" : ""].join(" ")}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-6 shrink-0 font-sans text-[9px] tabular-nums text-ink-ghost">{String(index + 1).padStart(2, "0")}</span>
        <span className="min-w-0 flex-1 truncate">{abbreviatedToolSummary(card)}</span>
        {/* ボタンは完了ラベルの左。 opacity-0 でも幅は持つので完了位置は常にサマリー行の右端と揃う */}
        <CopyButton copied={copied} onClick={onCopy} label="ツールコールをコピー" reveal={REVEAL_TOOL} />
        <span className={`shrink-0 font-sans text-[9px] ${phaseColor(card.phase)}`}>{phaseLabel(card.phase)}</span>
      </div>
      <div className="mt-1.5 grid gap-1.5 pl-6 text-ink-muted">
        {card.args ? (
          <div className="grid min-w-0 gap-0.5">
            <span className="font-sans text-[9px] uppercase tracking-wide text-ink-faint">引数</span>
            <code className="whitespace-pre-wrap break-words">{card.args}</code>
          </div>
        ) : null}
        {card.phase === "running" ? (
          <div className="text-accent-text">実行中…</div>
        ) : card.output ? (
          <div className="grid min-w-0 gap-0.5">
            <span className="font-sans text-[9px] uppercase tracking-wide text-ink-faint">出力</span>
            <pre className="m-0 whitespace-pre-wrap break-words font-mono">{card.output}</pre>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ToolHistoryView({
  cards,
  hasResponse,
  copiedId,
  onCopyTool,
}: {
  cards: ToolCard[];
  hasResponse: boolean;
  copiedId: string;
  onCopyTool: (card: ToolCard) => void;
}) {
  const phase = historyPhase(cards);
  return (
    <details
      className={[
        "min-w-0 border-y border-line bg-soft/20 font-mono text-[10px] text-ink-muted",
        hasResponse ? "mb-2.5" : "",
      ].join(" ")}
    >
      <summary className="tool-summary flex min-w-0 cursor-pointer items-center gap-2 px-2 py-2 outline-none transition-colors hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent">
        <ChevronIcon />
        <span className="shrink-0 font-sans text-[10px] text-ink-soft">ツール履歴</span>
        <span className="shrink-0 font-sans text-[9px] text-ink-faint">{cards.length}件</span>
        <span className="min-w-0 flex-1 truncate">{historyPreview(cards)}</span>
        <span className={`shrink-0 font-sans text-[9px] ${phaseColor(phase)}`}>{phaseLabel(phase)}</span>
      </summary>
      <ol className="m-0 grid list-none border-t border-line px-2 pb-1">
        {cards.map((card, index) => (
          <ToolCallRow
            key={card.id}
            card={card}
            index={index}
            copied={copiedId === `tool_${card.id}`}
            onCopy={() => onCopyTool(card)}
          />
        ))}
      </ol>
    </details>
  );
}

function MessageView({
  bubble,
  copied,
  onCopy,
  copiedId,
  onCopyTool,
}: {
  bubble: Bubble;
  copied: boolean;
  onCopy: () => void;
  copiedId: string;
  onCopyTool: (card: ToolCard) => void;
}) {
  const isUser = bubble.role === "user";
  return (
    <article className={`animate-rise group/bubble flex gap-3 ${isUser ? "justify-end" : ""}`}>
      <div
        className={[
          "grid size-[26px] shrink-0 place-items-center rounded-lg text-[10px] font-bold",
          isUser ? "order-2 bg-accent-bright text-on-accent" : "border border-accent/25 bg-accent-wash text-accent",
        ].join(" ")}
      >
        {isUser ? <UserIcon /> : "✦"}
      </div>
      <div className="min-w-0 max-w-[min(760px,86%)] max-nav:max-w-[90%]">
        <div className="mb-1 text-[10px] font-medium text-ink-faint">{isUser ? "あなた" : "アシスタント"}</div>
        {!isUser && bubble.tools.length > 0 ? (
          <ToolHistoryView
            cards={bubble.tools}
            hasResponse={Boolean(bubble.text)}
            copiedId={copiedId}
            onCopyTool={onCopyTool}
          />
        ) : null}
        {bubble.text ? (
          <div
            className={[
              "whitespace-pre-wrap break-words text-[13px] leading-relaxed",
              isUser ? "rounded-2xl rounded-tr-md bg-accent-bright px-3.5 py-2.5 text-on-accent" : "text-ink-soft",
            ].join(" ")}
          >
            {bubble.text}
          </div>
        ) : null}
        {bubble.text ? (
          <div className={["mt-1 flex", isUser ? "justify-end" : ""].join(" ")}>
            <CopyButton copied={copied} onClick={onCopy} label="メッセージをコピー" reveal={REVEAL_MESSAGE} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

export type ChatAreaProps = {
  bubbles: Bubble[];
  onSuggestion: (prompt: string) => void;
};

export function ChatArea({ bubbles, onSuggestion }: ChatAreaProps) {
  const chatAreaRef = useRef<HTMLElement>(null);
  const { copiedId, copyMessage } = useMessageCopy();

  // 新しいメッセージ / 追記があったら最下部へ (旧実装の scrollTop 追従)
  useEffect(() => {
    const el = chatAreaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles]);

  return (
    <section
      ref={chatAreaRef}
      aria-live="polite"
      className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6 max-nav:px-[18px] wide:px-8"
    >
      <div className="mx-auto w-full min-w-0 max-w-[880px]">
        {bubbles.length === 0 ? (
          <div className="mx-auto max-w-md pt-[18vh] text-center max-nav:pt-[10vh]">
            <div className="mx-auto mb-4 grid size-[42px] place-items-center rounded-[13px] border border-accent/25 bg-accent-wash text-lg text-accent">
              ✦
            </div>
            <h2 className="text-xl font-semibold text-ink-strong max-nav:text-lg">プロジェクトの相棒です</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
              コードを読んだり、ファイルを編集したり、コマンドを実行できます。
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.prompt}
                  type="button"
                  onClick={() => onSuggestion(s.prompt)}
                  className="min-h-9 rounded-lg border border-line bg-raised px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-5 pt-2">
            {bubbles.map((bubble) => (
              <MessageView
                key={bubble.id}
                bubble={bubble}
                copied={copiedId === `bubble_${bubble.id}`}
                onCopy={() => void copyMessage(bubble.text, `bubble_${bubble.id}`)}
                copiedId={copiedId}
                onCopyTool={(card) => void copyMessage(toolCallCopyText(card), `tool_${card.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
