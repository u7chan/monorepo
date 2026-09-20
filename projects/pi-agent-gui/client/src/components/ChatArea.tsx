import { Fragment, useEffect, useRef } from "react";
import type { Bubble } from "../hooks/chatReducer";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { cn } from "../lib/cn";
import { compactionDividerIndex } from "../lib/compaction";
import { toolCallCopyText, toolHistoryCopyText } from "../lib/copy-content";
import type { AgentSuggestion, CompactionInfo } from "../types";
import { CompactionDivider } from "./chat/CompactionDivider";
import { MessageView } from "./chat/MessageView";

export type ChatAreaProps = {
  bubbles: Bubble[];
  compactions?: CompactionInfo[];
  compact?: boolean;
  suggestions?: AgentSuggestion[];
  /** セッションの作業フォルダ (root 相対)。添付のサムネイル URL を組むのに使う */
  cwd?: string;
  onSuggestion: (prompt: string) => void;
  /** 非表示 (設定ページ) の間は scrollHeight を読めないので同期を止める */
  visible?: boolean;
};

export function ChatArea({
  bubbles,
  compactions = [],
  compact = false,
  suggestions = [],
  cwd = "",
  onSuggestion,
  visible = true,
}: ChatAreaProps) {
  const chatAreaRef = useRef<HTMLElement>(null);
  const { copiedId, copyMessage } = useMessageCopy();
  const dividerIndex = compactionDividerIndex(compactions);

  // 設定ページから戻ったときにも最新位置へ戻す (非表示中は scrollHeight が 0 になる)
  useEffect(() => {
    if (!visible) return;
    const el = chatAreaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles, visible]);

  return (
    <section
      ref={chatAreaRef}
      aria-live="polite"
      className={cn(
        "min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto",
        compact ? "px-3 pb-4" : "px-6 pb-6 wide:px-8",
      )}
    >
      <div className={cn("mx-auto w-full min-w-0", compact ? null : "max-w-220")}>
        {bubbles.length === 0 ? (
          <div className={cn("mx-auto max-w-md text-center", compact ? "pt-[8vh]" : "pt-[18vh]")}>
            <div className="mx-auto mb-4 grid size-10.5 place-items-center rounded-xl border border-accent/25 bg-accent-wash text-lg text-accent-strong">
              ✦
            </div>
            <h2 className={cn("font-semibold text-ink-strong", compact ? "text-lg" : "text-xl")}>
              プロジェクトの相棒です
            </h2>
            <p className="mt-2 text-1sm leading-relaxed text-ink-soft">
              コードを読んだり、ファイルを編集したり、コマンドを実行できます。
            </p>
            {suggestions.length > 0 ? (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s.prompt}
                    type="button"
                    onClick={() => onSuggestion(s.prompt)}
                    className="min-h-9 rounded-lg border border-line bg-raised px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className={cn("grid min-w-0 grid-cols-1 pt-2", compact ? "gap-3.5" : "gap-5")}>
            {bubbles.map((bubble, index) => (
              <Fragment key={bubble.id}>
                {dividerIndex === index ? <CompactionDivider compactions={compactions} compact={compact} /> : null}
                <MessageView
                  bubble={bubble}
                  copied={copiedId === `bubble_${bubble.id}`}
                  compact={compact}
                  cwd={cwd}
                  // 添付の注記を除いた本文をコピーする (MessageView が分解して渡す)
                  onCopy={(text) => void copyMessage(text, `bubble_${bubble.id}`)}
                  copiedId={copiedId}
                  onCopyTool={(card) => void copyMessage(toolCallCopyText(card), `tool_${card.id}`)}
                  copiedAll={copiedId === `tools_${bubble.id}`}
                  onCopyAll={() => void copyMessage(toolHistoryCopyText(bubble.tools), `tools_${bubble.id}`)}
                />
              </Fragment>
            ))}
            {/* 区切りが末尾 (圧縮後のメッセージがまだ無い) のときは bubbles の後ろへ出す */}
            {dividerIndex !== undefined && dividerIndex >= bubbles.length ? (
              <CompactionDivider compactions={compactions} compact={compact} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
