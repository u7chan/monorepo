import type { Bubble, ToolCard } from "../../hooks/chatReducer";
import { splitAttachedFiles } from "../../lib/attachments";
import { cn } from "../../lib/cn";
import { messageFullTimeLabel, messageTimeLabel } from "../../lib/messageTime";
import { messageMetaLine, messageMetaTitle } from "../../lib/usageFormat";
import { MarkdownView } from "../markdown/MarkdownView";
import { AttachedFiles } from "./AttachedFiles";
import { CopyButton } from "./CopyButton";
import { ToolHistoryView } from "./ToolHistory";

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

export function MessageView({
  bubble,
  copied,
  compact,
  rootCwd,
  onCopy,
  copiedId,
  onCopyTool,
  copiedAll,
  onCopyAll,
}: {
  bubble: Bubble;
  copied: boolean;
  compact: boolean;
  /** ワークスペース root の絶対パス (health.cwd)。添付のサムネイル URL を組むのに使う */
  rootCwd: string;
  onCopy: (text: string) => void;
  copiedId: string;
  onCopyTool: (card: ToolCard) => void;
  copiedAll: boolean;
  onCopyAll: () => void;
}) {
  const isUser = bubble.role === "user";
  // 履歴の user 本文には添付の注記が入っている。表示とコピーは注記を除いた本文を使う
  const { text: bodyText, files } = isUser ? splitAttachedFiles(bubble.text) : { text: bubble.text, files: [] };
  const metaLine = isUser ? "" : messageMetaLine(bubble.usage, bubble.metrics, compact);
  const metaTitle = isUser ? undefined : messageMetaTitle(bubble.usage, bubble.metrics);
  return (
    <article
      className={cn("group/bubble flex min-w-0 animate-rise", compact ? "gap-2" : "gap-3", isUser ? "justify-end" : "")}
    >
      <div
        className={cn(
          "grid shrink-0 place-items-center rounded-lg font-bold",
          compact ? "size-5.5 text-3xs" : "size-6.5 text-2xs",
          isUser
            ? "order-2 bg-accent-bright text-on-accent"
            : "border border-accent/25 bg-accent-wash text-accent-strong",
        )}
      >
        {isUser ? <UserIcon /> : "✦"}
      </div>
      {/* flex-1 は assistant だけ。user に付けるとバブル背景が列幅まで広がる */}
      <div
        className={cn(
          "min-w-0",
          isUser ? "" : "flex-1",
          compact ? (isUser ? "max-w-[88%]" : "max-w-full") : "max-w-[min(760px,86%)]",
        )}
      >
        <div className={cn("text-2xs font-medium text-ink-faint", compact ? "mb-0.5" : "mb-1")}>
          {isUser ? "あなた" : "アシスタント"}
        </div>
        {!isUser && bubble.tools.length > 0 ? (
          <ToolHistoryView
            cards={bubble.tools}
            hasResponse={Boolean(bubble.text)}
            copiedId={copiedId}
            copiedAll={copiedAll}
            onCopyAll={onCopyAll}
            compact={compact}
            onCopyTool={onCopyTool}
          />
        ) : null}
        {bubble.text ? (
          isUser ? (
            <>
              <AttachedFiles files={files} rootCwd={rootCwd} compact={compact} />
              {bodyText ? (
                // user は打った文字がそのまま見えることを優先し、Markdown として解釈しない
                <div className="rounded-2xl rounded-tr-md bg-accent-bright px-3.5 py-2.5 text-1sm leading-relaxed break-words whitespace-pre-wrap text-on-accent">
                  {bodyText}
                </div>
              ) : null}
            </>
          ) : (
            <MarkdownView text={bubble.text} />
          )
        ) : null}
        {bubble.text || bubble.at !== undefined ? (
          <div
            className={cn(
              // メタ情報が長い / 狭いときは時刻行の下へ折り返す (数字の途中で折らない)
              "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1",
              isUser ? "justify-end" : "",
            )}
          >
            {bubble.at !== undefined ? (
              <time
                dateTime={new Date(bubble.at).toISOString()}
                title={messageFullTimeLabel(bubble.at)}
                className="shrink-0 font-sans text-2xs whitespace-nowrap text-ink-ghost tabular-nums"
              >
                {messageTimeLabel(bubble.at)}
              </time>
            ) : null}
            {metaLine ? (
              <span
                title={metaTitle}
                className="shrink-0 font-sans text-2xs whitespace-nowrap text-ink-faint tabular-nums"
              >
                {metaLine}
              </span>
            ) : null}
            {bodyText ? (
              <CopyButton
                copied={copied}
                onClick={() => onCopy(bodyText)}
                label="メッセージをコピー"
                reveal="message"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
