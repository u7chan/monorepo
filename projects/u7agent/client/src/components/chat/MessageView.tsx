import type { Bubble, ToolCard } from "../../hooks/chatReducer";
import { splitAttachedFiles } from "../../lib/attachments";
import { cn } from "../../lib/cn";
import { messageFullTimeLabel, messageTimeLabel } from "../../lib/messageTime";
import { splitSkillBlock } from "../../lib/skillBlock";
import { nonSkillToolCards, type SkillBadge } from "../../lib/skillLoad";
import { messageMetaLine, messageMetaTitle } from "../../lib/usageFormat";
import type { AskUserAnswer } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { MarkdownView } from "../markdown/MarkdownView";
import { AskUserCard } from "./AskUserCard";
import { AttachedFiles } from "./AttachedFiles";
import { CopyButton } from "./CopyButton";
import { SkillInvocation } from "./SkillInvocation";
import { SkillLoadList } from "./SkillLoadList";
import { ToolHistoryView } from "./ToolHistory";
import { UserMessageBody } from "./UserMessageBody";

/** onAnswer 未接続のバブル (履歴の復元など) に渡すフォールバック。カード側の answerable も false になる */
const rejectAnswer = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: "回答を送信できません" });

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
  skillBadges,
  copied,
  compact,
  agentName,
  agentIcon,
  rootCwd,
  onCopy,
  copiedId,
  onCopyTool,
  copiedAll,
  onCopyAll,
  onResend,
  onDiscard,
  answerable = false,
  onAnswerQuestion,
  animate = true,
}: {
  bubble: Bubble;
  /** 全バブル横断の dedup 済みバッジ (履歴優先。ChatArea が skillBadgesOf で組み立てる) */
  skillBadges: SkillBadge[];
  copied: boolean;
  compact: boolean;
  /** assistant の表示名 (セッションのスナップショット)。未指定は従来の「アシスタント」 */
  agentName?: string;
  /** 未設定なら SparkleIcon へフォールバックする */
  agentIcon?: string;
  /** ワークスペース root の絶対パス (health.cwd)。添付のサムネイル URL を組むのに使う */
  rootCwd: string;
  onCopy: (text: string) => void;
  copiedId: string;
  onCopyTool: (card: ToolCard) => void;
  copiedAll: boolean;
  onCopyAll: () => void;
  /** 未送信メッセージの再送。サーバーが保存済みの本文を使って実行し直す */
  onResend?: () => void;
  /** 未送信メッセージの破棄。再送が実行中の分はサーバーが拒否する */
  onDiscard?: () => void;
  /** このバブルが実行中の run に属するか (ask_user のカードを回答可能にするかの根拠) */
  answerable?: boolean;
  /** ask_user の回答。エラーはカード内に出し、入力は消さない */
  onAnswerQuestion?: (
    toolCallId: string,
    answers: AskUserAnswer[],
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 登場アニメーション。仮想スクロールで再マウントする履歴 item では再生しない (既定 true) */
  animate?: boolean;
}) {
  const isUser = bubble.role === "user";
  // 要約で置き換わった / context_edit で外れた発言は薄暗くし、理由をタグでも示す
  // (色だけに依存せず、最新の有効範囲の境界は ContextBoundary が担う)
  const contextTag = bubble.context === "summarized" ? "要約済み" : bubble.context === "excluded" ? "除外" : undefined;
  // 履歴の user 本文には添付の注記と `/skill:` の展開結果が入っている。表示とコピーは
  // 注記を除き、スキルブロックは畳んで見せる (打った本文 = 引数だけを吹き出しに残す)
  const { text: userBody, files } = isUser ? splitAttachedFiles(bubble.text) : { text: bubble.text, files: [] };
  const skill = isUser ? splitSkillBlock(userBody) : null;
  const bodyText = skill ? (skill.userMessage ?? "") : userBody;
  const metaLine = isUser ? "" : messageMetaLine(bubble.usage, bubble.metrics, compact);
  const metaTitle = isUser ? undefined : messageMetaTitle(bubble.usage, bubble.metrics);
  // スキル読み込みはバッジ、ask_user は専用カードへ出し、ツール履歴の件数・サマリー・コピーからは外す
  const toolCards = nonSkillToolCards(bubble.tools);
  const questionCards = isUser ? [] : bubble.tools.filter((card) => card.questions?.length);
  return (
    <article
      className={cn(
        "group/bubble flex min-w-0",
        animate ? "animate-rise" : "",
        compact ? "gap-2" : "gap-3",
        isUser ? "justify-end" : "",
        contextTag ? "opacity-60" : "",
      )}
    >
      {isUser ? (
        <div
          className={cn(
            "order-2 grid shrink-0 place-items-center rounded-lg bg-accent-bright font-bold text-on-accent",
            compact ? "size-5.5 text-3xs" : "size-6.5 text-2xs",
          )}
        >
          <UserIcon />
        </div>
      ) : (
        <AgentIcon icon={agentIcon} variant="bubble" compact={compact} />
      )}
      {/* flex-1 は assistant だけ。user に付けるとバブル背景が列幅まで広がる */}
      <div
        className={cn(
          "min-w-0",
          isUser ? "" : "flex-1",
          compact ? (isUser ? "max-w-[88%]" : "max-w-full") : "max-w-[min(760px,86%)]",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 text-2xs font-medium text-ink-faint",
            compact ? "mb-0.5" : "mb-1",
            isUser ? "justify-end" : "",
          )}
        >
          <span>{isUser ? "あなた" : agentName || "アシスタント"}</span>
          {isUser && bubble.unsent ? (
            <span
              title="実行されなかった送信です（サーバーの再起動や停止で中断）。本文を確認して再送するか、破棄してください"
              className="rounded-sm border border-warn/40 px-1 text-3xs font-normal text-warn"
            >
              未送信
            </span>
          ) : null}
          {contextTag ? (
            <span
              title={
                bubble.context === "summarized"
                  ? "要約に置き換わり、現在のコンテキストには含まれていません"
                  : "再試行や上限超過の回復でコンテキストから外れました"
              }
              className="rounded-sm border border-line px-1 text-3xs font-normal text-ink-muted"
            >
              {contextTag}
            </span>
          ) : null}
        </div>
        {!isUser ? <SkillLoadList badges={skillBadges} compact={compact} /> : null}
        {!isUser && toolCards.length > 0 ? (
          <ToolHistoryView
            cards={toolCards}
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
              {skill ? <SkillInvocation block={skill} rootCwd={rootCwd} compact={compact} /> : null}
              {bodyText ? (
                // user は打った文字がそのまま見えることを優先し、Markdown として解釈しない
                <div className="rounded-2xl rounded-tr-md bg-accent-bright px-3.5 py-2.5 text-1sm leading-relaxed text-on-accent">
                  <UserMessageBody text={bodyText} />
                </div>
              ) : null}
            </>
          ) : (
            <MarkdownView text={bubble.text} />
          )
        ) : null}
        {questionCards.length > 0 ? (
          <div className={cn("grid", compact ? "mt-2 gap-2" : "mt-2.5 gap-2.5")}>
            {questionCards.map((card) => (
              <AskUserCard
                key={card.id}
                card={card}
                answerable={answerable === true && onAnswerQuestion !== undefined}
                onAnswer={onAnswerQuestion ?? rejectAnswer}
                compact={compact}
              />
            ))}
          </div>
        ) : null}
        {isUser && bubble.unsent ? (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
            <span className="text-2xs text-warn">送信が中断されました</span>
            {onResend ? (
              <button type="button" onClick={onResend} className="btn-quiet min-h-7 px-2.5 text-2xs">
                再送
              </button>
            ) : null}
            {onDiscard ? (
              <button type="button" onClick={onDiscard} className="btn-quiet min-h-7 px-2.5 text-2xs">
                破棄
              </button>
            ) : null}
          </div>
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
