import {
  canonicalUserText,
  fallbackEchoTarget,
  mergeHistoryPage,
  newestHistoryItemId,
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
  PendingSend,
  Usage,
} from "../types";

// 型の正は lib/chatTypes。既存の import 先 (components / tests) を保つために再配布する
export type { Bubble, ChatHistoryState, CompactionMarker, ToolCard, ToolPhase } from "../lib/chatTypes";
export type ChatState = {
  bubbles: Bubble[];
  nextId: number;
  currentAssistantId: number | null;
  toolBubbleIds: Record<string, number>;
  /**
   * 直近 run のツールカード (toolCallId -> ToolCall)。ライブの tool_start / tool_end と resync の
   * payload.run.toolCalls が正で、履歴ページにまだ投影されていないカードを補完する元データ。
   * runEnd では消さない (終了後に遅れて適用される履歴ページへ補うため)
   */
  runTools: Record<string, ToolCall>;
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
  /**
   * 停止で破棄された run id (queue_cleared)。応答 (`echoRunId`) より先に届くことがあり、そのときは
   * エコーに run id が無いため未送信へ切り替えられない。対応付いた時点で切り替えるために控える
   */
  clearedRunIds: string[];
  queueDepth: number;
  activity: string;
  /**
   * 活動表示の由来 (SSE `status` の state)。状態そのものではなく表示の補助で、
   * 「モデルがトークンを生成中」(thinking) だけを活動ラベルの演出に使う。
   * 文言 (activity) で判定すると BFF の文面変更で演出が消えるため、サーバーが配る state を持つ
   */
  activityState?: string;
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
  /**
   * run_start で観測した run id -> 展開済みの本文。送信応答 (`echoRunId`) が run_start より遅れて
   * 届いたときに、ローカルエコーを注記込み / `/skill:` 展開済みの本文へ差し替えるために使う。
   * 直近の数件だけ持ち、対応が取れたら消す (別 run の本文を自分のエコーへ入れない)
   */
  runPrompts: Record<string, string>;
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
  /** 上方向の追加取得 (古いページ)。cursor は要求時に読んだ先頭 item id で、適用中の先頭と一致したときだけ適用する */
  | { type: "prependHistory"; cursor: string; page: HistoryPage }
  | { type: "historyLoading"; loading: boolean }
  /** 旧サーバー (履歴 API 無し) / セッション消滅。payload.messages ベースの表示へ戻す */
  | { type: "historyUnsupported" }
  | { type: "runStart"; runId?: string; prompt: string; at: number; startedAt: number }
  | { type: "localUser"; text: string; at: number }
  /** 送信応答の run id。未対応付けの最古のエコーへ結び付け、自分の entry を run id で特定する */
  | { type: "echoRunId"; runId: string }
  /** 未送信メッセージの再送を開始する (保存済みの本文をサーバーが使う)。pending エコーへ戻す */
  | { type: "resendUnsent"; runId: string }
  /** 再送の受付に失敗した。pending を解除して未送信へ戻す */
  | { type: "resendFailed"; runId: string }
  /** 未送信メッセージを破棄した (サーバーの記録も消えている) */
  | {
      type: "unsentDiscarded";
      runId: string;
    } /** 送信に失敗したローカルエコーを戻す (待ち行列の末尾 = 直前に送った分) */
  | { type: "dropLocalUser" }
  | { type: "text"; delta: string; at: number }
  | { type: "toolStart"; id: string; name: string; args: string; skill?: SkillLoad; at: number }
  | { type: "toolEnd"; id: string; isError: boolean; output: string }
  | { type: "usage"; usage?: Usage; metrics?: MessageMetrics; context?: ContextUsage }
  | { type: "compaction"; compaction: CompactionInfo; count: number }
  | { type: "status"; state: string; text: string }
  | { type: "queued"; position: number; queueDepth: number }
  /** 停止で待機キューを破棄した。runIds は破棄された送信で、未送信の表示へ切り替える */
  | { type: "queueCleared"; runIds?: string[] }
  | { type: "retry"; retry: RunRetryState | null; totalRetryCount: number; serverNow: number; receivedAt: number }
  | {
      type: "runEnd";
      /** 終わった run の id。自分のエコーの run_start 待ちを卒業させるために使う */
      runId?: string;
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
  runTools: {},
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
  clearedRunIds: [],
  queueDepth: 0,
  activity: "",
  activityState: undefined,
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
  runPrompts: {},
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
/**
 * run_start に対応する自分の user entry が既に履歴へ載っているか (送信直前の preflight compaction など)。
 * 送信の run id が分かるときは runId が一致する item だけを見るので、別クライアントの同一文面 entry を
 * 自分のものにしない。run id が無い旧経路は、送信時点 (`echo.since`) より後に現れた runId 無しの
 * 同一文面へ縮退する (`fallbackEchoTarget`)。
 */
function echoAbsorbTarget(bubbles: Bubble[], markers: CompactionMarker[], echo: Bubble): Bubble | undefined {
  if (echo.runId !== undefined) {
    return bubbles.find(
      (bubble) => bubble.entryId !== undefined && bubble.role === "user" && bubble.runId === echo.runId,
    );
  }
  return fallbackEchoTarget(bubbles, markers, echo);
}

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

const RUN_PROMPT_LIMIT = 16;

/** run_start の本文を run id で控える。応答が遅れて届いてもエコーへ反映できるよう直近分だけ持つ */
function rememberRunPrompt(prompts: Record<string, string>, runId: string, prompt: string): Record<string, string> {
  const next = { ...prompts, [runId]: prompt };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - RUN_PROMPT_LIMIT))) delete next[key];
  return next;
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

/**
 * 補完先 = 最後の user バブルより後にある最後の assistant バブル。無ければ undefined (保留)。
 * entryId の有無を問わず、履歴ページ適用後の確定バブルにもライブの生成中バブルにも補う。
 */
function currentTurnAssistantId(bubbles: Bubble[]): number | undefined {
  let lastUser = -1;
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    if (bubbles[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = bubbles.length - 1; index > lastUser; index -= 1) {
    if (bubbles[index].role === "assistant") return bubbles[index].id;
  }
  return undefined;
}

/**
 * run 側のツール状態を現在ターンの assistant バブルへ反映する。補完先が無いときは補完せず
 * 保持だけする (保留)。ページを組み直す位置から呼ぶので、ID で突き合わせてべき等にする。
 * focus は running の resync 用で、true のときだけ currentAssistantId を補完先へ向ける。
 */
function attachRunToolCards(state: ChatState, focus: boolean): ChatState {
  const calls = Object.values(state.runTools);
  if (calls.length === 0) return state;
  const targetId = currentTurnAssistantId(state.bubbles);
  if (targetId === undefined) return state;
  const attached = attachToolCalls(state, targetId, calls);
  return focus ? { ...attached, currentAssistantId: targetId } : attached;
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

/**
 * payload.pendingSends (202 で受理したがまだ entry になっていない送信) をバブル列へ写す。
 * `unsent` は pending を外して「未送信」へ切り替え、`queued` / `running` は受理済みの pending として
 * 保つ (別タブの再送中に表示から消さない)。手元にバブルが無い分は末尾へ足す (履歴の初回応答前でも
 * 失わない)。一覧から消えた未送信バブルは、別タブの再送 / 破棄で記録が消えたものとして落とす。
 * `undefined` (旧サーバー) は現状維持。payload に載った run は停止の控え (`clearedRunIds`) から外す。
 */
function applyPendingSends(
  bubbles: Bubble[],
  pendingEchoIds: number[],
  nextId: number,
  clearedRunIds: string[],
  pendingSends: PendingSend[] | undefined,
): { bubbles: Bubble[]; pendingEchoIds: number[]; nextId: number; clearedRunIds: string[] } {
  if (pendingSends === undefined) return { bubbles, pendingEchoIds, nextId, clearedRunIds };
  const byRunId = new Map(pendingSends.map((send) => [send.runId, send]));
  const pending = new Set(pendingEchoIds);
  const seen = new Set<string>();
  const next: Bubble[] = [];
  let cursor = nextId;
  for (const bubble of bubbles) {
    if (bubble.runId === undefined) {
      next.push(bubble);
      continue;
    }
    const send = byRunId.get(bubble.runId);
    if (send?.state === "unsent") {
      pending.delete(bubble.id);
      seen.add(bubble.runId);
      next.push({ ...bubble, unsent: true, accepted: false });
      continue;
    }
    if (send !== undefined) {
      // 実行中 / キュー待ち。未送信の表示を戻し、entry が載ったときの吸収に載せる
      seen.add(bubble.runId);
      if (bubble.entryId === undefined) pending.add(bubble.id);
      next.push({ ...bubble, unsent: false, accepted: true });
      continue;
    }
    // 一覧に無い = 保存済みか破棄済み。未送信のバブルはここで落とす (保存済みは entry が担う)
    if (bubble.unsent === true) continue;
    next.push(bubble);
  }
  for (const send of pendingSends) {
    if (seen.has(send.runId)) continue;
    const id = cursor++;
    if (send.state === "unsent") {
      next.push({
        id,
        role: "user",
        text: send.text,
        tools: [],
        skillLoads: [],
        at: send.at,
        runId: send.runId,
        unsent: true,
      });
      continue;
    }
    // 受理済み (キュー待ち / 実行中) もバブルを持たせる。履歴の初回応答前でも消さない
    pending.add(id);
    next.push({
      id,
      role: "user",
      text: send.text,
      tools: [],
      skillLoads: [],
      at: send.at,
      runId: send.runId,
      accepted: true,
    });
  }
  return {
    bubbles: next,
    // pending から外した分を落とし、queued / running で新たに載せた分を末尾へ足す
    pendingEchoIds: [...pending],
    nextId: cursor,
    // payload が載せた run は権威ある状態なので、停止の控えは不要
    clearedRunIds: clearedRunIds.filter((id) => !byRunId.has(id)),
  };
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
      // 直近 run のツール状態は payload が正。run の無い resync で前の run のカードを残さず、
      // SSE のリプレイ / 再接続の取りこぼしもここで復元する (sessionChanged でも必ず置き換わる)
      const runTools: Record<string, ToolCall> = {};
      for (const call of payload.run?.toolCalls ?? []) runTools[call.id] = call;
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
        runTools,
        // 履歴モードでは区切りを履歴ページが正とし、旧 payload では messages の index から復元する
        dividers: keepHistory ? state.dividers : legacyMarkers(payload.compactions ?? []),
        history: sessionChanged ? initialChatState.history : state.history,
        // 別の会話の停止で破棄された run id を持ち越さない
        clearedRunIds: sessionChanged ? [] : state.clearedRunIds,
        sessionId: payload.sessionId,
        runStatus: status,
        runStartedAt: status === "running" ? payload.run?.startedAt : undefined,
        // 圧縮の起点は payload の値だけ。終端 resync で status が抜ければ解除される
        compactionStartedAt: status === "compacting" ? payload.compactionStartedAt : undefined,
        queueDepth: payload.queueDepth || 0,
        activity: "",
        // 活動の由来は status イベントだけが入れる (復帰時の文言は状態ではなくお知らせなので持たない)
        activityState: undefined,
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
      // 未投影の run 側カードを現在ターンの assistant へ補う (補完先が無ければ保留)。
      // currentAssistantId は実行中のときだけ補完先へ向ける
      next = attachRunToolCards(next, status === "running");
      if (status === "running") {
        // 復帰の文言は長い 1 文 (「実行中…（タブを閉じても処理は続きます）」) なので由来を持たせない
        // (折り返すと帯が行ごとに切れる)。run 自身の短いラベルを配る次の status で再開する
        next = { ...next, activity: "実行中…（タブを閉じても処理は続きます）" };
      } else if (status === "compacting") next = { ...next, activity: "会話を整理中…" };
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
      const applied = applyPendingSends(
        next.bubbles,
        next.pendingEchoIds,
        next.nextId,
        next.clearedRunIds,
        payload.pendingSends,
      );
      return {
        ...next,
        bubbles: applied.bubbles,
        pendingEchoIds: applied.pendingEchoIds,
        nextId: applied.nextId,
        clearedRunIds: applied.clearedRunIds,
      };
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
      return attachRunToolCards(applyHistoryMerge(state, bundle, page), true);
    }

    case "historyGap": {
      const pending = state.history.pendingPage;
      // 古い応答 / 別の保留ページで解決済みなら何もしない
      if (!pending || state.history.gapCursor !== action.cursor) return state;
      const bundle = {
        bubbles: state.bubbles,
        markers: state.dividers,
        nextId: state.nextId,
        toolBubbleIds: state.toolBubbleIds,
      };
      const live = state.bubbles.filter((bubble) => bubble.entryId === undefined);
      // 1) 欠落区間のページを保持分へ適用する (繋がらなければ 1 ページに収まらない欠落)
      const gapMerge = mergeHistoryPage(bundle, action.page, { live, pendingEchoIds: state.pendingEchoIds });
      // 2) 保留していた最新ページを適用する
      if (!gapMerge.gap) {
        const latestMerge = mergeHistoryPage(gapMerge, pending, {
          live: gapMerge.bubbles.filter((bubble) => bubble.entryId === undefined),
          pendingEchoIds: gapMerge.pendingEchoIds,
        });
        if (!latestMerge.gap) return attachRunToolCards(applyHistoryMerge(state, latestMerge, pending), true);
      }
      // 3) 欠落区間が 1 ページに収まらない / 分岐が変わった。取ってある gap ページは
      //    保留ページと連続しているので捨てずに組み込み、カーソルを gap ページ側へ進める
      //    (同じ before を再取得しない)
      if (action.page.items.length > 0) {
        const rebuilt = rebuildHistoryPage(bundle, action.page, { live, pendingEchoIds: state.pendingEchoIds });
        const withPending = mergeHistoryPage(rebuilt, pending, {
          live: rebuilt.bubbles.filter((bubble) => bubble.entryId === undefined),
          pendingEchoIds: rebuilt.pendingEchoIds,
        });
        // メタデータ (nextCursor / hasMore / counts) は古い方 (= gap ページ) を正とする
        if (!withPending.gap) return attachRunToolCards(applyHistoryMerge(state, withPending, action.page), true);
      }
      return attachRunToolCards(
        applyHistoryMerge(
          state,
          rebuildHistoryPage(bundle, pending, { live, pendingEchoIds: state.pendingEchoIds }),
          pending,
        ),
        true,
      );
    }

    case "historyGapFailed": {
      if (state.history.gapCursor !== action.cursor) return state;
      return { ...state, history: { ...state.history, gapCursor: null, pendingPage: null } };
    }

    case "prependHistory": {
      const page = action.page;
      // 取得中にブランチ / 保持分の先頭が変わっていたら、旧ブランチのページを混ぜない
      if (state.history.nextCursor !== action.cursor) return state;
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
        { pendingEchoIds: state.pendingEchoIds },
      );
      return {
        ...state,
        bubbles: bundle.bubbles,
        dividers: bundle.markers,
        nextId: bundle.nextId,
        toolBubbleIds: bundle.toolBubbleIds,
        pendingEchoIds: bundle.pendingEchoIds,
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
      // 自分の送信を実行する run は run id で厳密に照合する。run id が分からないエコー (応答待ち) は
      // 照合せず保持し、別クライアントの同一文面 entry を誤って自分のものにしない。
      // 別タブが未送信メッセージを再送した場合は、その run_start で未送信の表示を送信中へ戻す
      const resent =
        action.runId === undefined
          ? undefined
          : state.bubbles.find((bubble) => bubble.unsent === true && bubble.runId === action.runId);
      const base =
        resent === undefined
          ? state
          : {
              ...state,
              bubbles: state.bubbles.map((bubble) =>
                bubble.id === resent.id ? { ...bubble, unsent: false, accepted: true } : bubble,
              ),
              pendingEchoIds: [...state.pendingEchoIds, resent.id],
            };
      const promptBody = canonicalUserText(action.prompt);
      const echoIndex =
        action.runId !== undefined
          ? base.pendingEchoIds.findIndex((id) => base.bubbles.find((item) => item.id === id)?.runId === action.runId)
          : base.pendingEchoIds.findIndex((id) => {
              const bubble = base.bubbles.find((item) => item.id === id);
              return bubble !== undefined && canonicalUserText(bubble.text) === promptBody;
            });
      const echo = echoIndex === -1 ? undefined : base.bubbles.find((b) => b.id === base.pendingEchoIds[echoIndex]);
      // 対応が取れた 1 件だけ待ち行列から外す。run id 不明の旧経路は送信順に届く前提を保つ
      const pendingEchoIds =
        echoIndex === -1
          ? base.pendingEchoIds
          : action.runId !== undefined
            ? base.pendingEchoIds.filter((_, index) => index !== echoIndex)
            : base.pendingEchoIds.slice(echoIndex + 1);
      const pending = new Set(base.pendingEchoIds);
      let next: ChatState;
      if (echo !== undefined) {
        const absorb = echoAbsorbTarget(base.bubbles, base.dividers, echo);
        if (absorb !== undefined) {
          // preflight compaction などで自分の entry が既に履歴へ載っている。エコーを履歴 item へ
          // 吸収し、同じ発言の二重表示を防ぐ
          next = { ...base, bubbles: base.bubbles.filter((bubble) => bubble.id !== echo.id) };
        } else {
          next =
            echo.text === action.prompt
              ? base
              : updateBubble(base, echo.id, (bubble) => ({ ...bubble, text: action.prompt }));
        }
      } else {
        // 待ち行列のエコーが本文の正規形で一致するなら、自分の run_start が応答より先に届いた場合なので
        // 二重に足さない (別クライアントの同一文面はページの item を正とする)
        const known =
          base.bubbles.some((bubble) => bubble.role === "user" && bubble.text === action.prompt) ||
          base.bubbles.some((bubble) => pending.has(bubble.id) && canonicalUserText(bubble.text) === promptBody);
        next = known ? base : appendBubble(base, "user", action.prompt, action.at);
      }
      return {
        ...next,
        pendingEchoIds,
        // run_start の本文を控えておく。応答が遅れて届いたエコーを展開後の本文へ差し替えるのに使う
        runPrompts:
          action.runId === undefined
            ? next.runPrompts
            : rememberRunPrompt(next.runPrompts, action.runId, action.prompt),
        currentAssistantId: null,
        toolBubbleIds: {},
        runTools: {},
        runStatus: "running",
        runStartedAt: action.startedAt,
        // 圧縮の終端では run_start より先に終端 resync が届く (回復時も残さない)
        compactionStartedAt: undefined,
        activity: "実行を開始しました",
        activityState: undefined,
        // 前の run の保留値・再試行状態を引き継がない (累計は結果表示用に残す)
        pendingUsage: undefined,
        pendingMetrics: undefined,
        retry: undefined,
        retryRemainingMs: undefined,
        retryReceivedAt: undefined,
        retryCount: 0,
        // 前のランの失敗は引き継がない (新しいランの開始でカードを消す)
        runError: undefined,
        // 実行が始まった run は停止の控えから外す (遅れて届いた 202 で未送信へ戻さない)
        clearedRunIds:
          action.runId === undefined ? next.clearedRunIds : next.clearedRunIds.filter((id) => id !== action.runId),
      };
    }

    case "localUser": {
      const next = appendBubble(state, "user", action.text, action.at);
      const echoId = next.nextId - 1;
      // 送信時点で既知の最新 item。run_start の吸収判定でこれより後の entry だけを自分の候補にする
      const since = newestHistoryItemId(state.bubbles, state.dividers);
      return {
        ...next,
        bubbles: next.bubbles.map((bubble) => (bubble.id === echoId ? { ...bubble, since } : bubble)),
        currentAssistantId: null,
        activity: "送信中…",
        activityState: undefined,
        pendingEchoIds: [...state.pendingEchoIds, echoId],
        // 送信の合図。post が失敗して echo を戻しても減らさない (最下部に居続ける方が都合が良い)
        sendSeq: state.sendSeq + 1,
      };
    }

    case "echoRunId": {
      // 送信応答の run id を、未対応付けの最古のエコーへ結び付ける (送信は直列なので順序で足りる)。
      // run_start が応答より先に届いていても、これで自分の run と厳密に対応付く
      const echoId = state.pendingEchoIds.find((id) => {
        const bubble = state.bubbles.find((item) => item.id === id);
        return bubble !== undefined && bubble.runId === undefined;
      });
      if (echoId === undefined) return state;
      // payload が先にバブルを足していたら、ローカルのエコーへ寄せて重複を作らない
      // (同じ run id のバブルが 2 件残ると再送 / 破棄が二重に見える)。履歴 item は下の吸収が担う
      const duplicate = state.bubbles.find(
        (bubble) => bubble.id !== echoId && bubble.runId === action.runId && bubble.entryId === undefined,
      );
      // run_start が応答より先に届いていれば、控えた本文でローカルエコーを差し替える
      const prompt = state.runPrompts[action.runId];
      const withRunId = updateBubble(
        duplicate === undefined ? state : { ...state, bubbles: state.bubbles.filter((b) => b.id !== duplicate.id) },
        echoId,
        (bubble) => ({
          ...bubble,
          runId: action.runId,
          // 先にあったバブルの状態 (未送信 / 受理済み) を引き継ぐ
          ...(duplicate?.unsent === true ? { unsent: true, accepted: false } : {}),
          ...(duplicate?.accepted === true ? { unsent: false, accepted: true } : {}),
          ...(prompt !== undefined ? { text: prompt } : {}),
        }),
      );
      const runPrompts = { ...state.runPrompts };
      delete runPrompts[action.runId];
      // 保存済みの entry が既にあれば、停止の控えより吸収を優先する (権威ある履歴を正とする)
      const target = withRunId.bubbles.find(
        (bubble) => bubble.entryId !== undefined && bubble.role === "user" && bubble.runId === action.runId,
      );
      if (target !== undefined) {
        return {
          ...withRunId,
          runPrompts,
          bubbles: withRunId.bubbles.filter((bubble) => bubble.id !== echoId),
          pendingEchoIds: withRunId.pendingEchoIds.filter((id) => id !== echoId),
          clearedRunIds: state.clearedRunIds.filter((id) => id !== action.runId),
        };
      }
      // 停止で破棄された run か、payload が未送信として配った run なら、通常の送信済みに見せず
      // 未送信へ切り替える (重複して足されたバブルはローカルのエコーへ寄せる)
      if (state.clearedRunIds.includes(action.runId) || duplicate?.unsent === true) {
        return {
          ...withRunId,
          runPrompts,
          bubbles: withRunId.bubbles.map((bubble) =>
            bubble.id === echoId ? { ...bubble, unsent: true, accepted: false } : bubble,
          ),
          pendingEchoIds: withRunId.pendingEchoIds.filter((id) => id !== echoId),
          clearedRunIds: state.clearedRunIds.filter((id) => id !== action.runId),
        };
      }
      return { ...withRunId, runPrompts };
    }

    case "resendUnsent": {
      // 未送信バブルを pending エコーへ戻す。本文はサーバー側が持つ生テキストを使うため、ここでは
      // 表示だけを通常の送信直後へ切り替える (run id は再送でも変わらない)
      const index = state.bubbles.findIndex((bubble) => bubble.unsent === true && bubble.runId === action.runId);
      if (index === -1) return state;
      const echo = state.bubbles[index];
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === index ? { ...bubble, unsent: false, accepted: true, at: Date.now() } : bubble,
        ),
        currentAssistantId: null,
        pendingEchoIds: [...state.pendingEchoIds, echo.id],
        // 停止で破棄された記録を再送するときは、未送信へ戻す控えを消す
        clearedRunIds: state.clearedRunIds.filter((id) => id !== action.runId),
        activity: "送信中…",
        activityState: undefined,
        // 送信と同じく最下部への追従の合図を進める
        sendSeq: state.sendSeq + 1,
      };
    }

    case "resendFailed": {
      // 再送を受け付けてもらえなかった。通常の送信済みに見せないよう未送信へ戻す
      const index = state.bubbles.findIndex((bubble) => bubble.unsent === false && bubble.runId === action.runId);
      if (index === -1) return state;
      const echo = state.bubbles[index];
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === index ? { ...bubble, unsent: true, accepted: false } : bubble,
        ),
        pendingEchoIds: state.pendingEchoIds.filter((id) => id !== echo.id),
      };
    }

    case "unsentDiscarded":
      return {
        ...state,
        bubbles: state.bubbles.filter((bubble) => !(bubble.unsent === true && bubble.runId === action.runId)),
      };

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
      // 保留していた run 側カードは、ensureAssistant が補完先を作った時点で補う
      const withBubble = attachRunToolCards(ensureAssistant(state, action.at), false);
      return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
    }

    case "toolStart": {
      const call: ToolCall = {
        id: action.id,
        name: action.name || "",
        args: action.args || "",
        isError: false,
        done: false,
        output: "",
        ...(action.skill ? { skill: action.skill } : {}),
      };
      // 保留中の run 側カードを先に補ってから新しいカードを足す (逆順だと初回の assistant バブルで
      // 新規が先頭になり、run 側の挿入順と逆のツール履歴になる)
      const withBubble = attachRunToolCards(ensureAssistant(state, action.at), false);
      const withRun = { ...withBubble, runTools: { ...withBubble.runTools, [action.id]: call } };
      return addToolCard(withRun, toolCardOf(call), action.at);
    }

    case "toolEnd": {
      // run 側を更新してから補完する (ページ取得がツール完了前に走っていても done / failed に揃う)
      const call = state.runTools[action.id];
      const withRun =
        call === undefined
          ? state
          : {
              ...state,
              runTools: {
                ...state.runTools,
                [action.id]: { ...call, done: true, isError: action.isError, output: action.output },
              },
            };
      const bubbleId = withRun.toolBubbleIds[action.id];
      // run 側に無い call (run の無い resync 後) でも、履歴ページのカードが索引にあれば位相を反映する
      const withCard =
        bubbleId === undefined
          ? withRun
          : updateBubble(withRun, bubbleId, (b) => ({
              ...b,
              tools: b.tools.map((card) =>
                card.id === action.id
                  ? { ...card, phase: action.isError ? "failed" : "done", output: action.output }
                  : card,
              ),
            }));
      return attachRunToolCards(withCard, false);
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
        // 圧縮の通知は状態ではなく 1 回きりのお知らせなので、活動ラベルの演出は外す
        activityState: undefined,
      };
    }

    case "status":
      // state は演出の条件 (thinking のときだけ活動ラベルに光を流す)、text は表示文言
      return { ...state, activity: action.text || "処理中…", activityState: action.state || undefined };

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
        activityState: undefined,
      };

    case "queueCleared": {
      // 破棄された待機メッセージは実行されない。run id が分かる分を未送信へ切り替え、
      // 「送信済み」の見た目のまま残さない。応答 (echoRunId) がまだ届いていないエコーは run id が
      // 無いため特定できず、控えを残して対応付いた時点で切り替える
      const cleared = new Set(action.runIds ?? []);
      const bubbles = state.bubbles.map((bubble) =>
        bubble.runId !== undefined && cleared.has(bubble.runId) && bubble.unsent !== true
          ? { ...bubble, unsent: true, accepted: false }
          : bubble,
      );
      const pendingEchoIds = state.pendingEchoIds.filter((id) => {
        const bubble = bubbles.find((item) => item.id === id);
        return bubble?.unsent !== true;
      });
      return {
        ...state,
        bubbles,
        pendingEchoIds,
        // 取りこぼしを防ぐため直近の分だけ持ち、対応が取れたら消す
        clearedRunIds: [...state.clearedRunIds, ...cleared].slice(-20),
        queueDepth: 0,
        activity: "待機キューを取り消しました",
        activityState: undefined,
      };
    }

    case "retry": {
      const retryState = mergeRetrySnapshot(state, action.retry, action.serverNow, action.receivedAt);
      return {
        ...state,
        ...retryState,
        retryCount: action.totalRetryCount,
        // 再試行の待機は生成中ではない (状態行の文言はクライアントが導出する)
        activityState: undefined,
      };
    }

    case "runEnd": {
      const { status, queueDepth } = action;
      // 自分の run が終わったら、その run のエコーは run_start 待ちを卒業する (履歴 item に run id が
      // 載らない縮退時は、ページ到着時に本文での突き合わせへ戻す)
      const pendingEchoIds =
        action.runId === undefined
          ? state.pendingEchoIds
          : state.pendingEchoIds.filter(
              (id) => state.bubbles.find((bubble) => bubble.id === id)?.runId !== action.runId,
            );
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
        pendingEchoIds,
        currentAssistantId: null,
        toolBubbleIds: {},
        activity,
        activityState: undefined,
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
        // 終わった run は停止の控えから外す (遅れて届いた 202 で未送信へ戻さない)
        clearedRunIds:
          action.runId === undefined
            ? settled.clearedRunIds
            : settled.clearedRunIds.filter((id) => id !== action.runId),
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
        // 応答で権威ある状態へ移した時点で演出も外す (status が来ない経路で光り続けない)
        activityState: undefined,
        // 送信の応答や停止の応答で権威ある状態へ移った時点でカードを消す (run_start が遅れても古い失敗を残さない)
        runError: undefined,
      };

    case "setActivity":
      // 実行とは別の知らせ (設定変更 / 接続エラーなど) を活動行へ出す。演出の対象外
      return { ...state, activity: action.text, activityState: undefined };
  }
}
