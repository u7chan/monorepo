import {
  canonicalUserText,
  mergeHistoryPage,
  prependHistoryPage,
  rebuildHistoryPage,
  toolCardOf,
} from "../lib/chatHistory";
import type { HistoryMergeResult } from "../lib/chatHistory";
import { compactionDividerIndex } from "../lib/compaction";
import type { Bubble, ChatHistoryState, CompactionMarker, ToolCard } from "../lib/chatTypes";
import { retryableRunError, runErrorFrom, type RunErrorInfo } from "../lib/runRetry";
import type {
  ChatMessage,
  CompactionInfo,
  ContextUsage,
  HistoryPage,
  MessageMetrics,
  RunErrorCode,
  RunRetryState,
  RunStatus,
  SessionPayload,
  SkillLoad,
  ThinkingLevel,
  ToolCall,
  Usage,
} from "../types";

// 型の正は lib/chatTypes。既存の import 先 (components / tests) を保つために再配布する
export type { Bubble, ChatHistoryState, CompactionMarker, ToolCard, ToolPhase } from "../lib/chatTypes";
export type ChatState = {
  bubbles: Bubble[];
  nextId: number;
  currentAssistantId: number | null;
  toolBubbleIds: Record<string, number>;
  /** 表示中のセッション。切替 (resync の sessionId 変化) で履歴ページを捨てる */
  sessionId: string;
  /** 圧縮イベントの区切り位置。復元は全履歴の entry 順、旧 payload では beforeMessageIndex */
  dividers: CompactionMarker[];
  /** 古いページを前置きした回数。ChatArea がスクロールアンカーの補正に使う */
  prependSeq: number;
  /** 全履歴ページの取得状態。supported=false の間は payload.messages から表示を組む */
  history: ChatHistoryState;
  runStatus: RunStatus;
  /** 実行中ランの開始時刻 (epoch ms)。サーバーが配る値だけを使う (受信時刻は使わない) */
  runStartedAt?: number;
  /**
   * 手動圧縮の開始時刻 (epoch ms)。payload の compactionStartedAt だけを使う
   * (runStartedAt とは別に持ち、圧縮の経過時間に使う)
   */
  compactionStartedAt?: number;
  /**
   * run が終わった回数。run_end と、running を抜けた resync で進む。値そのものは表示に使わず、
   * チャットの右パネル (作業フォルダ) が取り直しの合図に使う (描画間の runStatus の差では、
   * run_start と run_end が同じバッチで届いたときに running を観測できない)。
   */
  runEndSeq: number;
  /**
   * 送信 (ローカルエコー) の回数。値そのものは表示に使わず、チャットの自動追従が最下部へ戻る合図に使う。
   * バブルの形 (件数と末尾の role) では、履歴を全置換する resync と送信を区別できない。
   */
  sendSeq: number;
  /**
   * run_start 待ちのローカルエコー (user バブル id)。送信した順に並び、run_start が先頭から消費する。
   * 同じ本文を続けて送っても、届いた注記を正しいバブルに割り当てるために必要 (配列の末尾だけを見ると取り違える)。
   */
  pendingEchoIds: number[];
  queueDepth: number;
  activity: string;
  sessionModel?: string;
  sessionThinkingLevel?: string;
  /** セッション作成時のエージェントのスナップショット (定義を編集しても既存セッションの表示は変わらない) */
  sessionAgentId?: string;
  sessionAgentName?: string;
  supportsThinking: boolean;
  availableThinkingLevels: ThinkingLevel[];
  context?: ContextUsage;
  compactions: CompactionInfo[];
  pendingUsage?: Usage;
  pendingMetrics?: MessageMetrics;
  /** 進行中の自動再試行。resync / run_retry で復元し、run_end で消える */
  retry?: RunRetryState;
  /**
   * 最後に失敗したランの分類コードと文言。`runStatus === "error"` のときだけ持ち
   * (停止と例外が同時の `run_end` は `stopped` になる)、カードを出す場合は活動欄から文言を外す。
   * 失敗の文言は `run.error` (BFF が合成した 1 文) をそのまま使う
   */
  runError?: RunErrorInfo;
  /** retry の残り時間 (受信時点)。retryAt - serverNow で出し、ブラウザ時計は受信後の経過だけに使う */
  retryRemainingMs?: number;
  /** retry を受信したときのブラウザ時刻 (経過の起点) */
  retryReceivedAt?: number;
  /** ラン中の再試行スケジュール累計 (結果表示用。新しいランで 0 に戻す) */
  retryCount: number;
};

export type ChatAction =
  | { type: "newChat" }
  | { type: "resync"; payload: SessionPayload; receivedAt?: number }
  /** 全履歴の最新ページ。取得済みの古いページを残して新しい側だけを差し替える */
  | { type: "resyncHistory"; page: HistoryPage }
  /** 欠落区間の取得結果。保留中の最新ページと合わせて適用する */
  | { type: "historyGap"; cursor: string; page: HistoryPage }
  /** 欠落区間の取得失敗。保留を解いて次の resync で取り直せるようにする */
  | { type: "historyGapFailed"; cursor: string }
  /** 上方向の追加取得 (古いページ) */
  | { type: "prependHistory"; page: HistoryPage }
  | { type: "historyLoading"; loading: boolean }
  /** 旧サーバー (履歴 API 無し) / セッション消滅。payload.messages ベースの表示へ戻す */
  | { type: "historyUnsupported" }
  | { type: "runStart"; prompt: string; at: number; startedAt: number }
  | { type: "localUser"; text: string; at: number }
  /** 送信に失敗したローカルエコーを戻す (待ち行列の末尾 = 直前に送った分) */
  | { type: "dropLocalUser" }
  | { type: "text"; delta: string; at: number }
  | { type: "toolStart"; id: string; name: string; args: string; skill?: SkillLoad; at: number }
  | { type: "toolEnd"; id: string; isError: boolean; output: string }
  | { type: "usage"; usage?: Usage; metrics?: MessageMetrics; context?: ContextUsage }
  | { type: "compaction"; compaction: CompactionInfo; count: number }
  | { type: "status"; text: string }
  | { type: "queued"; position: number; queueDepth: number }
  | { type: "queueCleared" }
  | { type: "retry"; retry: RunRetryState | null; totalRetryCount: number; serverNow: number; receivedAt: number }
  | {
      type: "runEnd";
      status: RunStatus;
      queueDepth: number;
      error?: string;
      /** 最終失敗の分類コード。`status === "error"` のときだけサーバーが載せる */
      errorCode?: RunErrorCode;
      context?: ContextUsage;
      totalRetryCount?: number;
    }
  | { type: "setRun"; runStatus: RunStatus; queueDepth?: number; activity?: string }
  | { type: "setActivity"; text: string };

export const initialChatState: ChatState = {
  bubbles: [],
  nextId: 1,
  currentAssistantId: null,
  toolBubbleIds: {},
  sessionId: "",
  dividers: [],
  prependSeq: 0,
  history: {
    supported: false,
    hasMore: false,
    nextCursor: null,
    loading: false,
    messageCount: 0,
    summarizedMessageCount: 0,
    activeContextStartId: null,
    gapCursor: null,
    pendingPage: null,
  },
  runStatus: "idle",
  runStartedAt: undefined,
  compactionStartedAt: undefined,
  runEndSeq: 0,
  sendSeq: 0,
  pendingEchoIds: [],
  queueDepth: 0,
  activity: "",
  sessionModel: undefined,
  sessionThinkingLevel: undefined,
  sessionAgentId: undefined,
  sessionAgentName: undefined,
  supportsThinking: false,
  availableThinkingLevels: [],
  context: undefined,
  compactions: [],
  pendingUsage: undefined,
  pendingMetrics: undefined,
  retry: undefined,
  runError: undefined,
  retryRemainingMs: undefined,
  retryReceivedAt: undefined,
  retryCount: 0,
};

/** retryAt と serverNow の差を残り時間として控える。どちらか欠けたら undefined (推測で時刻を合成しない) */
function retrySnapshot(
  retry: RunRetryState | null | undefined,
  serverNow: number | undefined,
  receivedAt: number,
): Pick<ChatState, "retry" | "retryRemainingMs" | "retryReceivedAt"> {
  if (!retry) return { retry: undefined, retryRemainingMs: undefined, retryReceivedAt: undefined };
  const remaining =
    retry.retryAt === undefined || serverNow === undefined ? undefined : Math.max(0, retry.retryAt - serverNow);
  // 残りが無いとき (retrying / 復元不能) は tick の起点も持たない
  return { retry, retryRemainingMs: remaining, retryReceivedAt: remaining === undefined ? undefined : receivedAt };
}

/**
 * 同じ待機 (同じ attempt / retryAt) を再度受けたときは、既に得た期限を後ろへずらさない。
 * SSE のリプレイで古い `run_retry` / `resync` が届いても、受信時刻の更新で待機を延長しないための保険。
 */
function mergeRetrySnapshot(
  state: ChatState,
  retry: RunRetryState | null | undefined,
  serverNow: number | undefined,
  receivedAt: number,
): Pick<ChatState, "retry" | "retryRemainingMs" | "retryReceivedAt"> {
  const next = retrySnapshot(retry, serverNow, receivedAt);
  const sameWaiting =
    next.retry?.phase === "waiting" &&
    state.retry?.phase === "waiting" &&
    state.retry.attempt === next.retry.attempt &&
    state.retry.retryAt !== undefined &&
    state.retry.retryAt === next.retry.retryAt;
  const keptRemaining = state.retryRemainingMs;
  const keptReceivedAt = state.retryReceivedAt;
  const nextDeadline = next.retryRemainingMs === undefined ? undefined : receivedAt + next.retryRemainingMs;
  const keptDeadline =
    keptRemaining === undefined || keptReceivedAt === undefined ? undefined : keptReceivedAt + keptRemaining;
  if (sameWaiting && nextDeadline !== undefined && keptDeadline !== undefined && nextDeadline > keptDeadline) {
    return { retry: next.retry, retryRemainingMs: keptRemaining, retryReceivedAt: keptReceivedAt };
  }
  return next;
}

/** 旧 payload の compactions から区切りを復元する (位置を持つのは最新の 1 件だけ) */
function legacyMarkers(compactions: CompactionInfo[]): CompactionMarker[] {
  const index = compactionDividerIndex(compactions);
  const latest = compactions[compactions.length - 1];
  if (index === undefined || !latest) return [];
  return [{ id: latest.id, index, compactions }];
}

/** 履歴ページの適用結果を chat 状態へ写す (保留中の gap は解消済みにする) */
function applyHistoryMerge(state: ChatState, merged: HistoryMergeResult, page: HistoryPage): ChatState {
  return {
    ...state,
    bubbles: merged.bubbles,
    nextId: merged.nextId,
    toolBubbleIds: merged.toolBubbleIds,
    currentAssistantId: null,
    dividers: merged.markers,
    pendingEchoIds: merged.pendingEchoIds,
    sessionId: page.sessionId,
    history: {
      supported: true,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      loading: state.history.loading,
      messageCount: page.messageCount,
      summarizedMessageCount: page.summarizedMessageCount,
      activeContextStartId: page.activeContextStartId,
      gapCursor: null,
      pendingPage: null,
    },
  };
}

/** 送信エコーの照合用の正規形。添付の注記を落とし、`/skill:` の展開結果は打ったコマンドの形へ戻す。
 * ローカルエコー (素の入力) と run_start (展開済みの本文) を同じ形に寄せるために使う。 */
function appendBubble(state: ChatState, role: Bubble["role"], text = "", at?: number): ChatState {
  const bubble: Bubble = { id: state.nextId, role, text, tools: [], skillLoads: [], at };
  return {
    ...state,
    bubbles: [...state.bubbles, bubble],
    nextId: state.nextId + 1,
  };
}

function updateBubble(state: ChatState, id: number, update: (bubble: Bubble) => Bubble): ChatState {
  return { ...state, bubbles: state.bubbles.map((b) => (b.id === id ? update(b) : b)) };
}

function patchAssistant(state: ChatState, update: (bubble: Bubble) => Bubble): ChatState {
  if (state.currentAssistantId === null) return state;
  return updateBubble(state, state.currentAssistantId, update);
}

/** at は生成元イベントの時刻 */
function ensureAssistant(state: ChatState, at?: number): ChatState {
  if (state.currentAssistantId !== null && state.bubbles.some((b) => b.id === state.currentAssistantId)) {
    return state;
  }
  const next = appendBubble(state, "assistant", "", at);
  const bubbleId = next.nextId - 1;
  // ツール呼び出しだけの応答は usage の方が先に届くので、ここで作ったバブルへ回す
  const withMeta =
    next.pendingUsage || next.pendingMetrics
      ? updateBubble(next, bubbleId, (bubble) => ({
          ...bubble,
          usage: next.pendingUsage,
          metrics: next.pendingMetrics,
        }))
      : next;
  return {
    ...withMeta,
    currentAssistantId: bubbleId,
    pendingUsage: undefined,
    pendingMetrics: undefined,
  };
}

function addToolCard(state: ChatState, card: ToolCard, at?: number): ChatState {
  const withBubble = ensureAssistant(state, at);
  const bubbleId = withBubble.currentAssistantId as number;
  return {
    ...updateBubble(withBubble, bubbleId, (b) => ({ ...b, tools: [...b.tools, card] })),
    toolBubbleIds: { ...withBubble.toolBubbleIds, [card.id]: bubbleId },
  };
}

/** 履歴の導出値を写し忘れると resync でツール履歴やバッジが黙って消える */
export function historyToBubbles(
  nextId: number,
  messages: ChatMessage[],
): { bubbles: Bubble[]; nextId: number; toolBubbleIds: Record<string, number> } {
  const toolBubbleIds: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();
  const bubbles: Bubble[] = messages.map((message) => {
    const id = nextId++;
    const tools = (message.tools ?? [])
      .filter((call) => {
        if (seenToolCallIds.has(call.id)) return false;
        seenToolCallIds.add(call.id);
        return true;
      })
      .map(toolCardOf);
    for (const card of tools) toolBubbleIds[card.id] = id;
    return {
      id,
      role: message.role,
      text: message.text,
      tools,
      skillLoads: message.skillLoads ?? [],
      at: message.at,
      usage: message.usage,
      metrics: message.metrics,
    };
  });
  return { bubbles, nextId, toolBubbleIds };
}

function attachToolCalls(state: ChatState, bubbleId: number, toolCalls: ToolCall[]): ChatState {
  let next = state;
  for (const call of toolCalls) {
    const card = toolCardOf(call);
    const existingBubbleId = next.toolBubbleIds[call.id];
    if (existingBubbleId !== undefined) {
      // 履歴と run が重なる瞬間は run の位相が正なので、所属バブルを保ってカードを更新する。
      next = updateBubble(next, existingBubbleId, (bubble) => ({
        ...bubble,
        tools: bubble.tools.map((existing) => (existing.id === call.id ? card : existing)),
      }));
      continue;
    }
    next = {
      ...updateBubble(next, bubbleId, (bubble) => ({ ...bubble, tools: [...bubble.tools, card] })),
      toolBubbleIds: { ...next.toolBubbleIds, [call.id]: bubbleId },
    };
  }
  return next;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "newChat":
      // 未作成チャットは sessionModel 等の実効値を持たず、表示は composerSettings が担う。
      // nextId だけは引き継ぐ (セッションを跨いで古いイベントの bubble id と衝突させない)。
      // runEndSeq も引き継ぐ (右パネルの合図をセッションを跨いで単調に保つ)。
      return {
        ...initialChatState,
        nextId: state.nextId,
        runEndSeq: state.runEndSeq,
        // sendSeq も単調に保つ (新規チャットへの切替を「送信」と誤読させない)
        sendSeq: state.sendSeq,
      };

    case "resync": {
      const payload = action.payload;
      const status = payload.status || "idle";
      const sessionChanged = payload.sessionId !== state.sessionId;
      // 全履歴 API が使える間は payload.messages (有効コンテキスト) ではなく履歴ページを表示の正とする。
      // 取得済みの古いページを消さないため、ここでは表示を組み直さない (最新ページは resyncHistory が届く)
      const keepHistory = state.history.supported && !sessionChanged;
      const legacy = keepHistory ? null : historyToBubbles(state.nextId, payload.messages ?? []);
      // 確定済みのライブバブル (前の run の応答 / 送信エコー) は、履歴ページが届くまで残す。未確定の
      // ストリーミング中の assistant だけを捨てる (context_edit の resync で失敗試行を取り消す契約)
      const live = keepHistory ? state.bubbles.filter((bubble) => bubble.entryId === undefined) : [];
      const keptLive = live.filter((bubble) => bubble.role === "user" || bubble.settled === true);
      const bubbles = keepHistory
        ? [...state.bubbles.filter((bubble) => bubble.entryId !== undefined), ...keptLive]
        : legacy!.bubbles;
      const nextId = keepHistory ? state.nextId : legacy!.nextId;
      const toolBubbleIds = keepHistory
        ? Object.fromEntries(bubbles.flatMap((bubble) => bubble.tools.map((card) => [card.id, bubble.id] as const)))
        : legacy!.toolBubbleIds;
      const retainedEchoIds = new Set(keptLive.filter((bubble) => bubble.role === "user").map((bubble) => bubble.id));
      // 履歴で置き換えたので、旧バブルを指すエコーの待ち行列は持ち越さない
      const retryState = mergeRetrySnapshot(
        state,
        payload.run?.retry,
        payload.serverNow,
        action.receivedAt ?? Date.now(),
      );
      // 失敗の分類コードは payload から復元する (run_end だけに依存しない)。status が error 以外なら載せない
      const runError = runErrorFrom(status, payload.run?.errorCode, payload.run?.error);
      // run が終わった合図。run_end を受け取れない復帰 (切断した SSE の resync) でも、running から
      // 抜けていれば進める (パネルの取り直しは run_end とこの 1 回で足りる)
      const runEnded = state.runStatus === "running" && status !== "running";
      let next: ChatState = {
        ...state,
        runEndSeq: state.runEndSeq + (runEnded ? 1 : 0),
        bubbles,
        nextId,
        // 残したローカルエコー以外の待ちは持ち越さない
        pendingEchoIds: state.pendingEchoIds.filter((id) => retainedEchoIds.has(id)),
        currentAssistantId: null,
        toolBubbleIds,
        // 履歴モードでは区切りを履歴ページが正とし、旧 payload では messages の index から復元する
        dividers: keepHistory ? state.dividers : legacyMarkers(payload.compactions ?? []),
        history: sessionChanged ? initialChatState.history : state.history,
        sessionId: payload.sessionId,
        runStatus: status,
        runStartedAt: status === "running" ? payload.run?.startedAt : undefined,
        // 圧縮の起点は payload の値だけ。終端 resync で status が抜ければ解除される
        compactionStartedAt: status === "compacting" ? payload.compactionStartedAt : undefined,
        queueDepth: payload.queueDepth || 0,
        activity: "",
        sessionModel: payload.model,
        sessionThinkingLevel: payload.thinkingLevel,
        sessionAgentId: payload.agent?.id,
        sessionAgentName: payload.agent?.name,
        supportsThinking: payload.supportsThinking ?? false,
        availableThinkingLevels: payload.availableThinkingLevels ?? [],
        context: payload.context,
        compactions: payload.compactions ?? [],
        pendingUsage: undefined,
        pendingMetrics: undefined,
        ...retryState,
        runError,
        // ランが終わっていても結果表示用に累計を引き継ぐ (run が無い復元では前の値のまま)
        retryCount: payload.run ? payload.run.totalRetryCount : state.retryCount,
      };
      if (payload.run?.toolCalls?.length && (status === "running" || status === "completed")) {
        const last = [...bubbles].reverse().find((b) => b.role === "assistant");
        if (last) {
          next = attachToolCalls(next, last.id, payload.run.toolCalls);
          next = { ...next, currentAssistantId: status === "running" ? last.id : null };
        }
      }
      if (status === "running") next = { ...next, activity: "実行中…（タブを閉じても処理は続きます）" };
      else if (status === "compacting") next = { ...next, activity: "会話を整理中…" };
      else if (status === "queued")
        next = { ...next, activity: `待機中のメッセージがあります（${payload.queueDepth}件）` };
      else if (status === "error")
        next = {
          ...next,
          // カードを出すとき (分類コードと status の両方が揃うとき) は文言をカードへ移し、
          // 状態行に同じ 1 文を二重に出さない。分類コードが無い縮退では現行どおり出す
          activity: retryableRunError(status, runError)
            ? ""
            : payload.run?.error
              ? `エラー: ${payload.run.error}`
              : "前回の実行でエラーが発生しました",
        };
      else if (status === "stopped") next = { ...next, activity: "前回の実行は停止されました" };
      return next;
    }

    case "resyncHistory": {
      const page = action.page;
      const live = state.bubbles.filter((bubble) => bubble.entryId === undefined);
      const bundle = mergeHistoryPage(
        { bubbles: state.bubbles, markers: state.dividers, nextId: state.nextId, toolBubbleIds: state.toolBubbleIds },
        page,
        { live, pendingEchoIds: state.pendingEchoIds },
      );
      // 保持分と繋がらない (別タブで limit 以上追記された / 分岐が変わった) ときは、
      // 欠落区間を取ってから最新ページを適用する。表示は保持分のまま待つ
      if (bundle.gap) {
        return {
          ...state,
          history: {
            ...state.history,
            supported: true,
            gapCursor: page.items[0]?.id ?? null,
            pendingPage: page.items.length > 0 ? page : null,
          },
        };
      }
      return applyHistoryMerge(state, bundle, page);
    }

    case "historyGap": {
      const pending = state.history.pendingPage;
      // 古い応答 / 別の保留ページで解決済みなら何もしない
      if (!pending || state.history.gapCursor !== action.cursor) return state;
      const live = state.bubbles.filter((bubble) => bubble.entryId === undefined);
      // 1) 欠落区間のページを保持分へ適用する (繋がらなければ 1 ページに収まらない欠落)
      const gapMerge = mergeHistoryPage(
        { bubbles: state.bubbles, markers: state.dividers, nextId: state.nextId, toolBubbleIds: state.toolBubbleIds },
        action.page,
        { live, pendingEchoIds: state.pendingEchoIds },
      );
      // 2) 保留していた最新ページを適用する。どちらかが繋がらなければ再構築へ縮退
      const latestMerge = gapMerge.gap
        ? null
        : mergeHistoryPage(gapMerge, pending, {
            live: gapMerge.bubbles.filter((bubble) => bubble.entryId === undefined),
            pendingEchoIds: gapMerge.pendingEchoIds,
          });
      const merged =
        latestMerge && !latestMerge.gap
          ? latestMerge
          : rebuildHistoryPage(
              {
                bubbles: state.bubbles,
                markers: state.dividers,
                nextId: state.nextId,
                toolBubbleIds: state.toolBubbleIds,
              },
              pending,
              { live, pendingEchoIds: state.pendingEchoIds },
            );
      return applyHistoryMerge(state, merged, pending);
    }

    case "historyGapFailed": {
      if (state.history.gapCursor !== action.cursor) return state;
      return { ...state, history: { ...state.history, gapCursor: null, pendingPage: null } };
    }

    case "prependHistory": {
      const page = action.page;
      const bundle = prependHistoryPage(
        {
          bubbles: state.bubbles,
          markers: state.dividers,
          nextId: state.nextId,
          toolBubbleIds: state.toolBubbleIds,
          messageCount: state.history.messageCount,
          summarizedMessageCount: state.history.summarizedMessageCount,
        },
        page,
      );
      return {
        ...state,
        bubbles: bundle.bubbles,
        dividers: bundle.markers,
        nextId: bundle.nextId,
        toolBubbleIds: bundle.toolBubbleIds,
        prependSeq: state.prependSeq + (bundle.prepended > 0 ? 1 : 0),
        history: {
          ...state.history,
          supported: true,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          loading: false,
          messageCount: page.messageCount,
          summarizedMessageCount: page.summarizedMessageCount,
          activeContextStartId: page.activeContextStartId,
        },
      };
    }

    case "historyLoading":
      return { ...state, history: { ...state.history, loading: action.loading } };

    case "historyUnsupported":
      return { ...state, history: { ...state.history, supported: false } };

    case "runStart": {
      // ローカルエコーは素の本文、run_start は注記込み・`/skill:` 展開済みの本文で届く。送信順の
      // 待ち行列を先頭から見て、同じ入力に戻した本文が一致するエコーを差し替える
      // (同一本文を続けて送っても取り違えない)
      const promptBody = canonicalUserText(action.prompt);
      const echoIndex = state.pendingEchoIds.findIndex((id) => {
        const bubble = state.bubbles.find((item) => item.id === id);
        return bubble !== undefined && canonicalUserText(bubble.text) === promptBody;
      });
      const echo = echoIndex === -1 ? undefined : state.bubbles.find((b) => b.id === state.pendingEchoIds[echoIndex]);
      // 一致した分までを消費する (run_start は送信順に届くため、それ以前の待ちは解決不能)
      const pendingEchoIds = echoIndex === -1 ? state.pendingEchoIds : state.pendingEchoIds.slice(echoIndex + 1);
      let next: ChatState;
      if (echo !== undefined) {
        next =
          echo.text === action.prompt
            ? state
            : updateBubble(state, echo.id, (bubble) => ({ ...bubble, text: action.prompt }));
      } else {
        // 待ち行列が無い (resync 後など) ときは、注記込みの本文が既にある履歴を重複させない。
        // resync 直後は複数の user バブルが並ぶため、最後の 1 件ではなく全バブルを完全一致で見る
        const known = state.bubbles.some((bubble) => bubble.role === "user" && bubble.text === action.prompt);
        next = known ? state : appendBubble(state, "user", action.prompt, action.at);
      }
      return {
        ...next,
        pendingEchoIds,
        currentAssistantId: null,
        toolBubbleIds: {},
        runStatus: "running",
        runStartedAt: action.startedAt,
        // 圧縮の終端では run_start より先に終端 resync が届く (回復時も残さない)
        compactionStartedAt: undefined,
        activity: "実行を開始しました",
        // 前の run の保留値・再試行状態を引き継がない (累計は結果表示用に残す)
        pendingUsage: undefined,
        pendingMetrics: undefined,
        retry: undefined,
        retryRemainingMs: undefined,
        retryReceivedAt: undefined,
        retryCount: 0,
        // 前のランの失敗は引き継がない (新しいランの開始でカードを消す)
        runError: undefined,
      };
    }

    case "localUser": {
      const next = appendBubble(state, "user", action.text, action.at);
      return {
        ...next,
        currentAssistantId: null,
        activity: "送信中…",
        pendingEchoIds: [...state.pendingEchoIds, next.nextId - 1],
        // 送信の合図。post が失敗して echo を戻しても減らさない (最下部に居続ける方が都合が良い)
        sendSeq: state.sendSeq + 1,
      };
    }

    case "dropLocalUser": {
      // post に失敗したエコーを戻す。残すと次の run_start (同じ本文) が失敗分を消費してしまう
      const last = state.pendingEchoIds.at(-1);
      if (last === undefined) return state;
      return {
        ...state,
        bubbles: state.bubbles.filter((bubble) => bubble.id !== last),
        pendingEchoIds: state.pendingEchoIds.slice(0, -1),
      };
    }

    case "text": {
      const withBubble = ensureAssistant(state, action.at);
      return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
    }

    case "toolStart":
      return addToolCard(
        state,
        {
          id: action.id,
          name: action.name || "",
          args: action.args || "",
          phase: "running",
          output: "",
          ...(action.skill ? { skill: action.skill } : {}),
        },
        action.at,
      );

    case "toolEnd": {
      const bubbleId = state.toolBubbleIds[action.id];
      if (bubbleId === undefined) return state;
      return updateBubble(state, bubbleId, (b) => ({
        ...b,
        tools: b.tools.map((card) =>
          card.id === action.id ? { ...card, phase: action.isError ? "failed" : "done", output: action.output } : card,
        ),
      }));
    }

    case "usage": {
      // ツールループは 1 バブルに統合されるため、後続メッセージの値で上書きされる (仕様)。
      const next = action.context ? { ...state, context: action.context } : state;
      if (state.currentAssistantId !== null) {
        return updateBubble(next, state.currentAssistantId, (b) => ({
          ...b,
          usage: action.usage ?? b.usage,
          metrics: action.metrics ?? b.metrics,
        }));
      }
      // まだ本文もツールカードも届いていない (tool 呼び出しだけの message_end が先に届く)。
      // 直前の run のバブルを書き換えず、値を保留して次に作るバブルへ回す。
      return {
        ...next,
        pendingUsage: action.usage ?? state.pendingUsage,
        pendingMetrics: action.metrics ?? state.pendingMetrics,
      };
    }

    case "compaction": {
      // 同じ状態を続けて resync が配る。ここでは SSE が途切れた場合にも回数と要約を残すため、
      // 1 件分を entry id で差し替える (messages の置き換えは resync が担う)。
      const index = state.compactions.findIndex((item) => item.id === action.compaction.id);
      const compactions =
        index === -1
          ? [...state.compactions, action.compaction]
          : state.compactions.map((item, i) => (i === index ? action.compaction : item));
      return {
        ...state,
        compactions,
        // 区切りの位置は次の resync の履歴ページが正。旧 payload では beforeMessageIndex から復元する
        dividers: state.history.supported ? state.dividers : legacyMarkers(compactions),
        activity: `会話を圧縮しました（${action.count}回目）`,
      };
    }

    case "status":
      return { ...state, activity: action.text || "処理中…" };

    case "queued":
      return {
        ...state,
        // 圧縮中は体感の状態を compacting のまま保つ (実際に走っているのは圧縮)
        runStatus: state.runStatus === "compacting" ? "compacting" : "running",
        queueDepth: action.queueDepth,
        activity:
          state.runStatus === "compacting"
            ? `圧縮中のため待機キューに追加しました（${action.position}件目）`
            : `実行中のため待機キューに追加しました（${action.position}件目）`,
      };

    case "queueCleared":
      return { ...state, queueDepth: 0, activity: "待機キューを取り消しました" };

    case "retry": {
      const retryState = mergeRetrySnapshot(state, action.retry, action.serverNow, action.receivedAt);
      return {
        ...state,
        ...retryState,
        retryCount: action.totalRetryCount,
      };
    }

    case "runEnd": {
      const { status, queueDepth } = action;
      // 失敗の分類コードは status === "error" のときだけ保持する (停止と例外が同時でもカードを出さない)
      const runError = runErrorFrom(status, action.errorCode, action.error);
      const runStatus: RunStatus = queueDepth > 0 ? "queued" : status === "completed" ? "idle" : status;
      // カードを出すときだけ状態行のエラー文言を空にし、同じ 1 文を二重に出さない。
      // キュー待ちを挟んだ run は queued なのでカードを出さず、現行の文言を維持する
      const cardShown = retryableRunError(runStatus, runError) !== undefined;
      let activity: string;
      if (status === "stopped") activity = "停止しました";
      else if (status === "error") activity = cardShown ? "" : `エラー: ${action.error || "実行に失敗しました"}`;
      else activity = queueDepth > 0 ? "完了。次のメッセージを実行します" : "完了";
      // 確定した応答のバブルは resync でも残す (履歴ページが届くまでの表示を維持する)
      const settled =
        state.currentAssistantId === null
          ? state
          : updateBubble(state, state.currentAssistantId, (bubble) => ({ ...bubble, settled: true }));
      return {
        ...settled,
        currentAssistantId: null,
        toolBubbleIds: {},
        activity,
        // run が終わったことを取り直しの合図として数える (描画を挟まず reducer で進める)
        runEndSeq: settled.runEndSeq + 1,
        runStartedAt: undefined,
        compactionStartedAt: undefined,
        runStatus,
        queueDepth,
        // 履歴反映後の最新値 (usage イベントの context は 1 応答分古い)
        context: action.context ?? state.context,
        // バブルが作られないまま run が終わった保留値は、次の run へ持ち越さない
        pendingUsage: undefined,
        pendingMetrics: undefined,
        // アクティブな再試行は終了で消す。累計は結果表示のため残す
        retry: undefined,
        retryRemainingMs: undefined,
        retryReceivedAt: undefined,
        retryCount: action.totalRetryCount ?? state.retryCount,
        runError,
      };
    }

    case "setRun":
      return {
        ...state,
        runStatus: action.runStatus,
        // 圧縮の起点は resync が持つ。応答などで compacting 以外へ移すときは残さない
        compactionStartedAt: action.runStatus === "compacting" ? state.compactionStartedAt : undefined,
        queueDepth: action.queueDepth ?? state.queueDepth,
        activity: action.activity ?? state.activity,
        // 送信の応答や停止の応答で権威ある状態へ移った時点でカードを消す (run_start が遅れても古い失敗を残さない)
        runError: undefined,
      };

    case "setActivity":
      return { ...state, activity: action.text };
  }
}
