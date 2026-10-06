import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Bubble, CompactionMarker } from "../hooks/chatReducer";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { anchoredScrollTop, chatRenderItems, estimateChatItemHeight, type ChatRenderItem } from "../lib/chatItems";
import { resolveScrollFollow, shouldLoadOlder } from "../lib/chatScroll";
import type { ChatScope } from "../lib/chatScope";
import { cn } from "../lib/cn";
import { toolCallCopyText, toolHistoryCopyText } from "../lib/copy-content";
import { nonSkillToolCards, skillBadgesOf } from "../lib/skillLoad";
import type { AgentSuggestion, AskUserAnswer, CompactionInfo } from "../types";
import { AgentIcon } from "./AgentIcon";
import { CompactionDivider } from "./chat/CompactionDivider";
import { ContextBoundary } from "./chat/ContextBoundary";
import { MessageView } from "./chat/MessageView";
import { ScrollToBottomButton } from "./chat/ScrollToBottomButton";

export type ChatAreaProps = {
  bubbles: Bubble[];
  /** 圧縮イベントの区切り (index = bubbles の何番目の手前か)。全履歴 API が正 */
  dividers?: CompactionMarker[];
  /** 全体の圧縮履歴 (要約の通し番号に使う) */
  compactions?: CompactionInfo[];
  /** 現在の有効コンテキストの先頭。要約済みが見えているときだけ境界ラベルを出す */
  activeContextStartId?: string | null;
  /** 上方向の追加取得の状態 (hasMore / 取得中) */
  historyHasMore?: boolean;
  historyLoading?: boolean;
  /** 古いページを前置きした回数。スクロール位置の補正の合図 */
  prependSeq?: number;
  onLoadOlder?: () => void;
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
  /** 未送信メッセージの再送 (サーバーが保存済みの本文を使う) */
  onResendUnsent?: (runId: string) => void;
  /** 未送信メッセージの破棄 */
  onDiscardUnsent?: (runId: string) => void;
  /** 実行中の run か (ask_user の回答を受け付けるかの根拠) */
  answerable?: boolean;
  /** ask_user の回答。エラーはカード内に出し、入力は消さない */
  onAnswerQuestion?: (
    toolCallId: string,
    answers: AskUserAnswer[],
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 非表示 (設定ページ) の間は scrollHeight を読めないので同期を止める */
  visible?: boolean;
  /**
   * 実行中のターンの assistant バブル id (ChatState.currentAssistantId)。run が終わるまで
   * ツール履歴のコピーを出さないための根拠。履歴ページから復元したバブル (entryId 付き) は
   * `settled` を持たないため、バブルの見た目ではなくこの id で判定する
   */
  currentAssistantId?: number | null;
};

export function ChatArea({
  bubbles,
  dividers = [],
  compactions = [],
  activeContextStartId = null,
  historyHasMore = false,
  historyLoading = false,
  prependSeq = 0,
  onLoadOlder,
  compact = false,
  suggestions = [],
  agentName,
  agentIcon,
  scope,
  rootCwd = "",
  sessionId,
  sendSeq,
  onSuggestion,
  onResendUnsent,
  onDiscardUnsent,
  answerable = false,
  onAnswerQuestion,
  visible = true,
  currentAssistantId = null,
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
  const prevPrependSeqRef = useRef(prependSeq);
  /** 古いページの前置き前に測った位置。前置き後の高さ増加ぶんだけ scrollTop を戻す */
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const { copiedId, copyMessage } = useMessageCopy();
  const items = useMemo(
    () => chatRenderItems({ bubbles, markers: dividers, compactions, activeContextStartId }),
    [bubbles, dividers, compactions, activeContextStartId],
  );
  // resync では run の toolCall が最後のバブルへまとまるため、全バブル横断で同じ呼び出しをバッジ 1 件に統合する
  const skillBadges = skillBadgesOf(bubbles);

  // 可変高さ (Markdown / ツール履歴 / 折りたたみ要約) を計測し、可視範囲 + overscan だけ DOM に載せる。
  // アイテムは entry id をキーにし、古いページを前置きしても同じ DOM を再利用する。
  // 画面より上で伸縮したアイテムの scrollTop 補正は virtual-core の既定 (anchorTo: "start") が担う。
  // 計測を rAF へずらし、ResizeObserver callback 内の同期レイアウト変更による
  // "ResizeObserver loop completed with undelivered notifications" を避ける
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => chatAreaRef.current,
    estimateSize: (index) => estimateChatItemHeight(items[index]),
    getItemKey: (index) => items[index].key,
    overscan: 8,
    useAnimationFrameWithResizeObserver: true,
  });

  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;

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
    // 未計測ぶんは推定高さなので、末尾 index へも明示的に寄せる (計測後のずれは observer が拾う)
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    // 代入の後に読んだ位置を基準にする (位置が変わらない代入でも更新する。基準が古いままだと、
    // 直後にレイアウト起因で届く scroll を上へ戻す操作と誤認する)
    lastTopRef.current = el.scrollTop;
  }

  /** 上端付近で古いページを要求する。位置の基準を先に控え、前置き後に補正する */
  function requestOlderHistory(): void {
    const el = chatAreaRef.current;
    if (el) anchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    loadOlderRef.current?.();
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
    if (shouldLoadOlder({ scrollTop: top, hasMore: historyHasMore, loading: historyLoading })) {
      requestOlderHistory();
    }
  }

  // 内容が伸びても、読み返し中 (follow が外れている) は位置を動かさない
  useEffect(() => {
    if (!followRef.current) return;
    snapToBottom();
  }, [items]);

  // ページが 1 画面に収まる (scroll イベントが来ない) ときも、古いページがあれば読み込む
  useEffect(() => {
    if (!historyHasMore || historyLoading) return;
    const el = chatAreaRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 1) requestOlderHistory();
  }, [items, historyHasMore, historyLoading]);

  // 古いページの前置きは scrollTop を高さの増加分だけずらし、閲覧中の位置を保つ
  useLayoutEffect(() => {
    if (prependSeq === prevPrependSeqRef.current) return;
    prevPrependSeqRef.current = prependSeq;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const el = chatAreaRef.current;
    if (!anchor || !el) return;
    el.scrollTop = anchoredScrollTop({
      anchorTop: anchor.top,
      anchorHeight: anchor.height,
      nextHeight: el.scrollHeight,
    });
    lastTopRef.current = el.scrollTop;
  }, [prependSeq]);

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

  function renderItem(item: ChatRenderItem) {
    if (item.kind === "boundary") return <ContextBoundary compact={compact} />;
    if (item.kind === "compaction") {
      return <CompactionDivider compactions={item.marker.compactions} startIndex={item.index} compact={compact} />;
    }
    const bubble = item.bubble;
    // 未送信の再送 / 破棄は run id を持つバブルだけに出す
    const unsentRunId = bubble.unsent === true ? bubble.runId : undefined;
    return (
      <MessageView
        bubble={bubble}
        skillBadges={skillBadges.get(bubble.id) ?? []}
        copied={copiedId === `bubble_${bubble.id}`}
        compact={compact}
        agentName={agentName}
        agentIcon={agentIcon}
        rootCwd={rootCwd}
        // 履歴 item はスクロールで再マウントするため、登場アニメーションはライブバブルだけにする
        animate={bubble.entryId === undefined}
        // 添付の注記を除いた本文をコピーする (MessageView が分解して渡す)
        onCopy={(text) => void copyMessage(text, `bubble_${bubble.id}`)}
        copiedId={copiedId}
        onCopyTool={(card) => void copyMessage(toolCallCopyText(card), `tool_${card.id}`)}
        copiedAll={copiedId === `tools_${bubble.id}`}
        onCopyAll={() => void copyMessage(toolHistoryCopyText(nonSkillToolCards(bubble.tools)), `tools_${bubble.id}`)}
        onResend={unsentRunId === undefined ? undefined : () => onResendUnsent?.(unsentRunId)}
        onDiscard={unsentRunId === undefined ? undefined : () => onDiscardUnsent?.(unsentRunId)}
        answerable={answerable}
        // run が終わるまでツール履歴のコピーを出さない (伸びている途中の断片をコピらせない)
        live={bubble.id === currentAssistantId}
        onAnswerQuestion={onAnswerQuestion}
      />
    );
  }

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
          {items.length === 0 ? (
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
            <div
              className="virtual-canvas relative mt-2 w-full"
              style={{ "--virtual-total-height": `${virtualizer.getTotalSize()}px` } as CSSProperties}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className={cn("virtual-item", compact ? "pb-3.5" : "pb-5")}
                  style={{ "--virtual-start": `${virtualItem.start}px` } as CSSProperties}
                >
                  {renderItem(items[virtualItem.index])}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      {/* aria-live の中に入れると読み上げに混ざるため、section の外へ浮かせる */}
      {!follow && items.length > 0 ? (
        <ScrollToBottomButton onClick={snapToBottom} className="absolute bottom-4 left-1/2 -translate-x-1/2" />
      ) : null}
    </div>
  );
}
