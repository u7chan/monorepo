import { useEffect, useRef } from "react";
import type { Bubble, ToolCard } from "../hooks/chatReducer";

const SUGGESTIONS = [
  { prompt: "このプロジェクトの構成を簡単に教えて", label: "プロジェクトを説明して" },
  { prompt: "まずテストがあるか確認して", label: "テストを確認して" },
  { prompt: "README を読んで改善案を3つ出して", label: "README をレビューして" },
];

function ToolCardView({ card }: { card: ToolCard }) {
  const first = `${card.name}${card.args ? ` — ${card.args}` : ""}`;
  const lines =
    card.phase === "running"
      ? [first, "実行中…"]
      : [first, card.phase === "failed" ? "エラー" : "完了", ...(card.output ? [card.output] : [])];
  return (
    <div
      className={[
        "whitespace-pre-wrap break-words rounded-md border border-line bg-soft/60 px-2.5 py-1.5 font-mono text-[10px]",
        card.phase === "done"
          ? "border-l-2 border-l-ok text-ink-muted"
          : card.phase === "failed"
            ? "border-l-2 border-l-danger text-danger-text"
            : "border-l-2 border-l-accent-strong text-ink-muted",
      ].join(" ")}
    >
      {lines.join("\n")}
    </div>
  );
}

function MessageView({ bubble }: { bubble: Bubble }) {
  const isUser = bubble.role === "user";
  return (
    <article className={`animate-rise flex gap-3 ${isUser ? "justify-end" : ""}`}>
      <div
        className={[
          "grid size-[26px] shrink-0 place-items-center rounded-lg text-[10px] font-bold",
          isUser ? "order-2 bg-accent-bright text-on-accent" : "border border-accent/25 bg-accent-wash text-accent",
        ].join(" ")}
      >
        {isUser ? "YOU" : "✦"}
      </div>
      <div className="min-w-0 max-w-[min(760px,86%)] max-nav:max-w-[90%]">
        <div className="mb-1 text-[10px] font-medium text-ink-faint">{isUser ? "あなた" : "pi agent"}</div>
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
        {!isUser && bubble.tools.length > 0 ? (
          <div className="mt-2.5 grid gap-1.5">
            {bubble.tools.map((card) => (
              <ToolCardView key={card.id} card={card} />
            ))}
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
              <MessageView key={bubble.id} bubble={bubble} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
