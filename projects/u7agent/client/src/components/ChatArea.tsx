import { Fragment, useEffect, useRef, useState } from "react";
import type { Bubble } from "../hooks/chatReducer";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { resolveScrollFollow } from "../lib/chatScroll";
import type { ChatScope } from "../lib/chatScope";
import { cn } from "../lib/cn";
import { compactionDividerIndex } from "../lib/compaction";
import { toolCallCopyText, toolHistoryCopyText } from "../lib/copy-content";
import { nonSkillToolCards, skillBadgesOf } from "../lib/skillLoad";
import type { AgentSuggestion, CompactionInfo } from "../types";
import { AgentIcon } from "./AgentIcon";
import { CompactionDivider } from "./chat/CompactionDivider";
import { MessageView } from "./chat/MessageView";
import { ScrollToBottomButton } from "./chat/ScrollToBottomButton";

export type ChatAreaProps = {
  bubbles: Bubble[];
  compactions?: CompactionInfo[];
  compact?: boolean;
  suggestions?: AgentSuggestion[];
  /** assistant の表示名 (セッションのスナップショット)。未作成チャットでは選択中のエージェント */
  agentName?: string;
  /** 未設定なら SparkleIcon へフォールバックする */
  agentIcon?: string;
  /** 作業先。空状態の見出しを「〈作業先〉で作業します」にするかの根拠 */
  scope: ChatScope;
  /** ワークスペース root の絶対パス (health.cwd)。添付のサムネイル URL を組むのに使う */
  rootCwd?: string;
  /** 会話の切替 ("" からの遷移 = 新規チャットの作成も含む)。変わったら最下部へ揃える */
  sessionId: string;
  /** 送信のたびに増える (reducer の localUser)。値そのものは表示に使わず、増加だけを追従の合図にする */
  sendSeq: number;
  onSuggestion: (prompt: string) => void;
  /** 非表示 (設定ページ) の間は scrollHeight を読めないので同期を止める */
  visible?: boolean;
};

export function ChatArea({
  bubbles,
  compactions = [],
  compact = false,
  suggestions = [],
  agentName,
  agentIcon,
  scope,
  rootCwd = "",
  sessionId,
  sendSeq,
  onSuggestion,
  visible = true,
}: ChatAreaProps) {
  const chatAreaRef = useRef<HTMLElement>(null);
  // 本文ブロック。ストリーミングで bubbles が増えない伸び (行の折り返し) は resize 側で拾う
  const contentRef = useRef<HTMLDivElement>(null);
  // follow = 最下部付近にいるか。判定は scroll イベントが 1 フレームに複数来るため ref、
  // ボタンの出し分けは state で持つ
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  // 直前に観測したスクロール位置。次に届く scroll が「上へ戻す操作」かを位置の向きで見分ける
  // (snap の代入でも更新する)
  const lastTopRef = useRef(0);
  const prevSendSeqRef = useRef(sendSeq);
  const prevSessionIdRef = useRef(sessionId);
  const { copiedId, copyMessage } = useMessageCopy();
  const dividerIndex = compactionDividerIndex(compactions);
  // resync では run の toolCall が最後のバブルへまとまるため、全バブル横断で同じ呼び出しをバッジ 1 件に統合する
  const skillBadges = skillBadgesOf(bubbles);

  function setFollowBoth(value: boolean): void {
    followRef.current = value;
    setFollow(value);
  }

  /** DOM への書き込みはこの 1 か所に閉じる。follow を立ててから書く。非表示中 (scrollHeight が 0) は書かない */
  function snapToBottom(): void {
    setFollowBoth(true);
    const el = chatAreaRef.current;
    if (!visible || !el) return;
    el.scrollTop = el.scrollHeight;
    // 代入の後に読んだ位置を基準にする (位置が変わらない代入でも更新する。基準が古いままだと、
    // 直後にレイアウト起因で届く scroll を上へ戻す操作と誤認する)
    lastTopRef.current = el.scrollTop;
  }

  function handleScroll(): void {
    const el = chatAreaRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const next = resolveScrollFollow({
      follow: followRef.current,
      previousTop: lastTopRef.current,
      scrollTop: top,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    lastTopRef.current = top;
    if (next.snap) snapToBottom();
    else setFollowBoth(next.follow);
  }

  // 内容が伸びても、読み返し中 (follow が外れている) は位置を動かさない
  useEffect(() => {
    if (!followRef.current) return;
    snapToBottom();
  }, [bubbles]);

  // 送信は状態の形から推測せず、ローカルエコーの増加で拾う (再接続の resync も末尾が user になり得る)
  useEffect(() => {
    if (sendSeq === prevSendSeqRef.current) return;
    prevSendSeqRef.current = sendSeq;
    snapToBottom();
  }, [sendSeq]);

  // 会話の切替は "" からの遷移も含めて最新へ揃える (新規チャットは添付のアップロードでも作られる)
  useEffect(() => {
    if (sessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = sessionId;
    snapToBottom();
  }, [sessionId]);

  // 設定ページから戻ったときに follow なら最新へ。外れていたときの読み位置は復元しない
  useEffect(() => {
    if (!visible || !followRef.current) return;
    snapToBottom();
  }, [visible]);

  // コンポーザの伸縮 / 右パネルのドラッグ / 添付の遅延ロード / リサイズで最下部が動いても追従を保つ。
  // observer は visible の間だけ張り、callback でも非表示と 0 サイズ (非表示中の通知) を除外する
  useEffect(() => {
    if (!visible) return;
    const section = chatAreaRef.current;
    const content = contentRef.current;
    if (!section || !content) return;
    const observer = new ResizeObserver(() => {
      if (!visible || !followRef.current) return;
      const el = chatAreaRef.current;
      if (!el || el.clientHeight === 0) return;
      snapToBottom();
    });
    observer.observe(section);
    observer.observe(content);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div className="relative flex min-h-0 min-w-0">
      <section
        ref={chatAreaRef}
        aria-live="polite"
        onScroll={handleScroll}
        className={cn(
          "min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto",
          compact ? "px-3 pb-4" : "px-6 pb-6 wide:px-8",
        )}
      >
        <div ref={contentRef} className={cn("mx-auto w-full min-w-0", compact ? null : "max-w-220")}>
          {bubbles.length === 0 ? (
            <div className={cn("mx-auto max-w-md text-center", compact ? "pt-[8vh]" : "pt-[18vh]")}>
              <div className="mx-auto mb-4 w-fit">
                <AgentIcon icon={agentIcon} variant="hero" />
              </div>
              <h2 className={cn("font-semibold text-ink-strong", compact ? "text-lg" : "text-xl")}>
                {scope.project ? `${scope.label} で作業します` : "プロジェクトの相棒です"}
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
                    skillBadges={skillBadges.get(bubble.id) ?? []}
                    copied={copiedId === `bubble_${bubble.id}`}
                    compact={compact}
                    agentName={agentName}
                    agentIcon={agentIcon}
                    rootCwd={rootCwd}
                    // 添付の注記を除いた本文をコピーする (MessageView が分解して渡す)
                    onCopy={(text) => void copyMessage(text, `bubble_${bubble.id}`)}
                    copiedId={copiedId}
                    onCopyTool={(card) => void copyMessage(toolCallCopyText(card), `tool_${card.id}`)}
                    copiedAll={copiedId === `tools_${bubble.id}`}
                    onCopyAll={() =>
                      void copyMessage(toolHistoryCopyText(nonSkillToolCards(bubble.tools)), `tools_${bubble.id}`)
                    }
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
      {/* aria-live の中に入れると読み上げに混ざるため、section の外へ浮かせる */}
      {!follow && bubbles.length > 0 ? (
        <ScrollToBottomButton onClick={snapToBottom} className="absolute bottom-4 left-1/2 -translate-x-1/2" />
      ) : null}
    </div>
  );
}
