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
import { ASK_USER_WAITING_TEXT, isPendingAskUser, pendingAskUserQuestionCount } from "../lib/askUser";
import { compactionDividerIndex } from "../lib/compaction";
import type { Bubble, ChatHistoryState, CompactionMarker, ToolCard } from "../lib/chatTypes";
import { isToolHostBubble } from "../lib/chatTypes";
import { retryableRunError, runErrorFrom, type RunErrorInfo } from "../lib/runRetry";
import { runOutcomeOf } from "../lib/turnEnd";
import type {
  AskUserAnswer,
  AskUserQuestion,
  AssistantMeta,
  ChatMessage,
  CompactionInfo,
  ContextUsage,
  HistoryPage,
  MessageMetrics,
  RunErrorCode,
  RunOutcome,
  RunRetryState,
  RunStatus,
  SessionHandoffState,
  SessionPayload,
  SessionTitleSummary,
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
  /**
   * payload が配る、表示 item にならない assistant 応答の時刻 / usage / 応答時間 (assistantId 引き)。
   * 本文なしの未回答 ask_user のために `runTools` から空のバブルを合成するときだけ使う
   */
  assistantMeta: Record<string, AssistantMeta>;
  /** 表示中のセッション。切替 (resync の sessionId 変化) で履歴ページを捨てる */
  sessionId: string;
  /** ヘッダ / お知らせに出す現在のタイトル。一覧の取得を待たず payload の値を正にする */
  title: string;
  /** タイトルの由来と AI 要約の試行 (旧サーバーは載せない) */
  titleSummary?: SessionTitleSummary;
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
   * ライブのツールイベント (`tool_start` / `tool_end`) で観測した toolCallId (古い→新しい)。
   * 診断スナップショットで、payload (resync) が持ち込んだ復元カードとライブ観測を区別する。
   */
  liveToolIds: string[];
  /**
   * run_start 待ちのローカルエコー (user バブル id)。送信した順に並び、run_start が先頭から消費する。
   * 同じ本文を続けて送っても、届いた注記を正しいバブルに割り当てるために必要 (配列の末尾だけを見ると取り違える)。
   */
  pendingEchoIds: number[];
  /**
   * 停止で破棄された送信ID (queue_cleared)。応答 (`echoSendId`) より先に届くことがあり、そのときは
   * エコーに送信IDが無いため未送信へ切り替えられない。対応付いた時点で切り替えるために控える
   */
  clearedSendIds: string[];
  queueDepth: number;
  activity: string;
  /**
   * 活動表示の由来 (SSE `status` の state)。状態そのものではなく表示の補助で、
   * 「モデルがトークンを生成中」(thinking) だけを活動ラベルの演出に使う。
   * 文言 (activity) で判定すると BFF の文面変更で演出が消えるため、サーバーが配る state を持つ
   */
  activityState?: string;
  /**
   * 利用者の操作の結果として出す 1 行 (待機の取り消しに失敗した理由など)。活動文言 (activity) は
   * status / resync が上書きするため、押した結果は別に持ち、次の操作の開始かセッション切替まで残す
   */
  notice?: string;
  sessionModel?: string;
  sessionThinkingLevel?: string;
  /** セッション作成時のエージェントのスナップショット (定義を編集しても既存セッションの表示は変わらない) */
  sessionAgentId?: string;
  sessionAgentName?: string;
  /**
   * 直前の引き継ぎの状態 (payload の handoff)。チップ (HANDOFF.md を参照) の表示条件を
   * 会話の状態から導出するために持ち、クライアントのメモリだけで持たない。
   */
  handoff?: SessionHandoffState;
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
   * 待機状態を含む権威ある状態の世代。送信応答の待機スナップショットと停止応答を、要求後に届いた
   * 新しい状態 (resync / run_start / queued / 終端 / 取消) へ適用しないために使う
   */
  stateSeq: number;
  /**
   * 送信IDより先に届いた `queued` の待機位置 (sendId -> position)。エコーが送信IDを結び付けた
   * 時点で 1 度だけ使い、より新しい状態 (注入・保存・取消) が届いたら捨てる
   */
  queuedSnapshots: Record<string, { position: number }>;
  /**
   * 実行中の run id。resync が同じ実行の継続か、前の応答を捨てる取り消しかを取り違えないために持つ
   * (ストリーミング中の assistant を続けてよいのは同じ run の resync だけ)
   */
  currentRunId?: string;
  /** 開いている assistant 応答のサーバー ID (`currentAssistantId` のバブルが持つ値) */
  currentAssistantKey?: string;
  /**
   * この実行で assistant_end まで観測した応答の本文。履歴再取得の照合で、同じターン内の
   * 前の応答を今の応答と取り違えないために使う
   */
  closedAssistantTexts: string[];
  /**
   * assistant_end で閉じた直後の応答カード。その応答が要求したツールは次の本文より先に届くため、
   * 次の delta が来るまではこのカードへ足す (新しいカードを空のまま作らない)
   */
  toolTargetAssistantId?: number;
  /**
   * 本文 item を引き取った host の応答ID。resyncHistory は履歴 item からバブルを組み直すため、
   * entryId 付きになった host は live の突き合わせ対象から外れ、印 (host) が写らない。run の終端まで
   * これらを host として戻し、再構築の後に実行中の行とコピーを出さない (1 run に複数の host が並び得る)
   */
  liveHostAssistantIds: string[];
  /**
   * `liveHostAssistantIds` を採用した run の id。切断中に前の run が終わり次の run が始まると
   * (`run_start` のリプレイなしで) `resync` だけが届くため、run が変わったら前ターンの host を
   * 復元しない。どちらかが不明 (旧サーバー) なときは run の変更を判定できないので保持する
   */
  liveHostRunId?: string;
  /**
   * run_start で観測した run id -> 展開済みの本文。送信応答 (`echoSendId`) が run_start より遅れて
   * 届いたときに、ローカルエコーを注記込み / `/skill:` 展開済みの本文へ差し替えるために使う。
   * 直近の数件だけ持ち、対応が取れたら消す (別 run の本文を自分のエコーへ入れない)
   */
  runPrompts: Record<string, string>;
  /**
   * run id -> その実行を開始した送信ID (run_start の initialSendId)。所要時間と結末は開始送信の
   * バブルにだけ写し、同じ実行へ注入された追加入力へ複製しない
   */
  runInitialSendIds: Record<string, string>;
  /**
   * 待機列の先頭が実行に移った直後の run id。アバターのリングを外へ 1 回広げるライブ専用の演出だけに
   * 使い、終端は DOM 側 (`startFlashEnd`) が受ける。run_end / queue_cleared / resync でも落とし、
   * 演出が残らないようにする
   */
  startingRunId?: string;
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
  | { type: "historyUnsupported"; payload?: SessionPayload }
  | { type: "runStart"; runId?: string; initialSendId?: string; prompt: string; at: number; startedAt: number }
  | { type: "localUser"; text: string; at: number }
  /** 送信応答。未対応付けの最古のエコーへ送信IDを結び付け、実行へ割り当て済みなら run id も写す。
   * `queuePosition` は応答が `queued` を返したときの `queueDepth` (= 押し込んだ直後の自分の順位) で、
   * `stateSeq` (要求時の世代) が現在と一致するときだけ適用する */
  | { type: "echoSendId"; sendId: string; runId?: string; queuePosition?: number; stateSeq?: number }
  /** 未送信メッセージの再送を開始する (保存済みの本文をサーバーが使う)。pending エコーへ戻す */
  | { type: "resendUnsent"; sendId: string }
  /** 再送の受付に失敗した。pending を解除して未送信へ戻す */
  | { type: "resendFailed"; sendId: string }
  /** 未送信メッセージを破棄した (サーバーの記録も消えている) */
  | {
      type: "unsentDiscarded";
      sendId: string;
    } /** 送信に失敗したローカルエコーを戻す (待ち行列の末尾 = 直前に送った分) */
  | { type: "dropLocalUser" }
  | { type: "text"; delta: string; at: number; assistantId?: string }
  /** assistant の応答が終わった。開いているカードを閉じ、次の delta を新しいカードで始める */
  | { type: "assistantEnd"; assistantId?: string }
  | {
      type: "toolStart";
      id: string;
      name: string;
      args: string;
      /** このツールを要求した assistant 応答のID */
      assistantId?: string;
      skill?: SkillLoad;
      questions?: AskUserQuestion[];
      /** BFF 計測の開始時刻。旧サーバーは載せない (実行時間を出さない) */
      startedAt?: number;
      at: number;
    }
  | {
      type: "toolEnd";
      id: string;
      isError: boolean;
      output: string;
      /** BFF 計測の終了時刻。旧サーバーは載せない (実行時間を出さない) */
      endedAt?: number;
      answers?: AskUserAnswer[];
    }
  /** investigate の子の進捗。ライブの ToolCall.progress だけを更新する */
  | { type: "toolProgress"; id: string; text: string }
  | { type: "usage"; usage?: Usage; metrics?: MessageMetrics; context?: ContextUsage; assistantId?: string }
  | { type: "compaction"; compaction: CompactionInfo; count: number }
  | { type: "status"; state: string; text: string }
  | { type: "queued"; sendId?: string; position: number; queueDepth: number }
  /** 停止で待機キューを破棄した。sendIds は破棄された送信で、未送信の表示へ切り替える */
  | { type: "queueCleared"; sendIds?: string[] }
  /** 待機中の 1 件を取り消した。その送信だけ未送信の表示へ切り替える (実行は止めない) */
  | { type: "queueCanceled"; sendId: string }
  /** 開始の Flash (リングの広がり) が DOM 側で終わった。ライブ専用の合図を落とす */
  | { type: "startFlashEnd" }
  | { type: "retry"; retry: RunRetryState | null; totalRetryCount: number; serverNow: number; receivedAt: number }
  | {
      type: "runEnd";
      /** 終わった run の id。自分のエコーの run_start 待ちを卒業させるために使う */
      runId?: string;
      status: RunStatus;
      queueDepth: number;
      /** BFF 計測のラン全体の所要時間。旧サーバーは載せない */
      durationMs?: number;
      error?: string;
      /** 最終失敗の分類コード。`status === "error"` のときだけサーバーが載せる */
      errorCode?: RunErrorCode;
      context?: ContextUsage;
      totalRetryCount?: number;
    }
  /** 停止応答。`stateSeq` (要求時の世代) が現在と一致するときだけ適用する */
  | { type: "setRun"; runStatus: RunStatus; queueDepth?: number; activity?: string; stateSeq?: number }
  | { type: "setActivity"; text: string }
  /** 操作の結果を状態行の下の 1 行に残す。後から届く status / resync では消さない */
  | { type: "notice"; text: string }
  /** 利用者の操作の開始。操作の結果 (notice) はここでだけ用済みにする (応答では消さない) */
  | { type: "clearNotice" }
  /**
   * 引き継ぎなど、同じ会話 id のまま履歴が入れ替わった世代を開く。旧バブルと履歴のカーソルを捨てる
   * (`resync` は同じ id を「履歴を保つ会話」と見るため、先に捨てないと前の世代が残る)。
   */
  | { type: "resetHistory" };

export const initialChatState: ChatState = {
  bubbles: [],
  nextId: 1,
  currentAssistantId: null,
  toolBubbleIds: {},
  runTools: {},
  assistantMeta: {},
  sessionId: "",
  title: "",
  titleSummary: undefined,
  dividers: [],
  prependSeq: 0,
  history: {
    supported: false,
    unsupported: false,
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
  liveToolIds: [],
  pendingEchoIds: [],
  clearedSendIds: [],
  queueDepth: 0,
  activity: "",
  activityState: undefined,
  notice: undefined,
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
  runInitialSendIds: {},
  stateSeq: 0,
  queuedSnapshots: {},
  currentRunId: undefined,
  currentAssistantKey: undefined,
  closedAssistantTexts: [],
  toolTargetAssistantId: undefined,
  liveHostAssistantIds: [],
  liveHostRunId: undefined,
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

/**
 * 履歴ページから取り込んだ item を表示に持つか (entryId はページ由来のバブルにだけ付く)。
 * ページ取得が一時的に失敗しても payload.messages (圧縮後は有効コンテキストだけ) へ
 * 表示を戻さないための判定に使う。
 */
function holdsFetchedHistory(state: ChatState): boolean {
  return state.bubbles.some((bubble) => bubble.entryId !== undefined);
}

/** 履歴ページの適用結果を chat 状態へ写す (保留中の gap は解消済みにする) */
/**
 * run_start に対応する自分の user entry が既に履歴へ載っているか (送信直前の preflight compaction など)。
 * 送信の run id が分かるときは runId が一致する item だけを見るので、別クライアントの同一文面 entry を
 * 自分のものにしない。run id が無い旧経路は、送信時点 (`echo.since`) より後に現れた runId 無しの
 * 同一文面へ縮退する (`fallbackEchoTarget`)。
 */
function echoAbsorbTarget(bubbles: Bubble[], markers: CompactionMarker[], echo: Bubble): Bubble | undefined {
  const live = (bubble: Bubble) => bubble.entryId !== undefined && bubble.role === "user";
  // 送信IDが分かるエコーは同じ送信IDの item だけへ吸収する (同じ実行の別の送信と取り違えない)
  if (echo.sendId !== undefined) {
    return bubbles.find((bubble) => live(bubble) && bubble.sendId === echo.sendId);
  }
  if (echo.runId !== undefined) {
    // 旧サーバーの item は送信IDを持たない。run の最初の user item へ従来どおり縮退する
    return bubbles.find((bubble) => live(bubble) && bubble.sendId === undefined && bubble.runId === echo.runId);
  }
  return fallbackEchoTarget(bubbles, markers, echo);
}

function mergeAssistantCard(live: Bubble, history: Bubble): Bubble {
  const liveIds = new Set(live.tools.map((card) => card.id));
  return {
    ...live,
    // 応答IDは履歴 item が持つ値を保つ。本文 item になっていないライブの host を
    // 取り込んだときに、item の対応付けの根拠を落とさないため
    ...(live.assistantId === undefined && history.assistantId !== undefined
      ? { assistantId: history.assistantId }
      : {}),
    // ライブのターンの印 (host) は引き継ぐ。履歴へ対応付いた後も run が終わるまでは live として扱い、
    // run_end / run_start で落とす。ここで外すと、resync のたびにコピーと実行中のカードが履歴へ出る
    host: live.host,
    text: live.text.length >= history.text.length ? live.text : history.text,
    entryId: history.entryId,
    context: history.context ?? live.context,
    at: live.at ?? history.at,
    usage: live.usage ?? history.usage,
    metrics: live.metrics ?? history.metrics,
    turnEnd: history.turnEnd ?? live.turnEnd,
    tools: [...live.tools, ...history.tools.filter((card) => !liveIds.has(card.id))],
    skillLoads: live.skillLoads.length > 0 ? live.skillLoads : history.skillLoads,
  };
}

function turnIndexOf(state: ChatState, liveId: number, bubbles: Bubble[]): number {
  const liveIndex = state.bubbles.findIndex((bubble) => bubble.id === liveId);
  if (liveIndex === -1) return -1;
  const turnUser = state.bubbles
    .slice(0, liveIndex)
    .reverse()
    .find((bubble) => bubble.role === "user");
  if (turnUser?.sendId === undefined) return -1;
  return bubbles.findIndex((bubble) => bubble.role === "user" && bubble.sendId === turnUser.sendId);
}

function stateIndexOfBubble(state: ChatState, bubble: Bubble): number {
  if (bubble.assistantId !== undefined) {
    const index = state.bubbles.findIndex((item) => item.assistantId === bubble.assistantId);
    if (index !== -1) return index;
  }
  if (bubble.sendId !== undefined) {
    const index = state.bubbles.findIndex((item) => item.sendId === bubble.sendId);
    if (index !== -1) return index;
  }
  if (bubble.runId !== undefined) {
    const index = state.bubbles.findIndex((item) => item.role === "user" && item.runId === bubble.runId);
    if (index !== -1) return index;
  }
  for (let index = state.bubbles.length - 1; index >= 0; index -= 1) {
    if (state.bubbles[index].role === bubble.role && state.bubbles[index].text === bubble.text) return index;
  }
  return -1;
}

function normalizeInitialSend(bubbles: Bubble[], initialSendId: string | undefined): Bubble[] {
  if (initialSendId === undefined) return bubbles;
  return bubbles.map((bubble) =>
    bubble.role === "user" && bubble.sendId === initialSendId && bubble.unsent !== true
      ? {
          ...bubble,
          queued: undefined,
          queuedState: undefined,
          queuePosition: undefined,
          unsent: false,
          accepted: true,
        }
      : bubble,
  );
}

function runIdentityOf(state: ChatState, bubbles: Bubble[]): { runId?: string; initialSendId?: string } {
  let runId = state.currentRunId;
  if (runId === undefined) {
    for (let index = bubbles.length - 1; index >= 0; index -= 1) {
      const bubble = bubbles[index];
      if (bubble.role === "user" && bubble.runId !== undefined) {
        runId = bubble.runId;
        break;
      }
      if (bubble.role === "assistant" && bubble.assistantId !== undefined) {
        const separator = bubble.assistantId.lastIndexOf(":");
        if (separator > 0) {
          runId = bubble.assistantId.slice(0, separator);
          break;
        }
      }
    }
  }
  if (runId === undefined) return {};
  const firstUser = bubbles.find(
    (bubble) =>
      bubble.role === "user" && bubble.runId === runId && bubble.sendId !== undefined && bubble.unsent !== true,
  );
  return { runId, initialSendId: state.runInitialSendIds[runId] ?? firstUser?.sendId };
}

function orderInitialUser(bubbles: Bubble[], runId: string | undefined, initialSendId: string | undefined): Bubble[] {
  if (runId === undefined) return bubbles;
  const userIndex =
    initialSendId === undefined
      ? bubbles.findIndex((bubble) => bubble.role === "user" && bubble.runId === runId && bubble.unsent !== true)
      : bubbles.findIndex(
          (bubble) => bubble.role === "user" && bubble.sendId === initialSendId && bubble.unsent !== true,
        );
  if (userIndex === -1) return bubbles;
  const prefix = `${runId}:`;
  const assistantIndex = bubbles.findIndex(
    (bubble) => bubble.role === "assistant" && bubble.assistantId?.startsWith(prefix) === true,
  );
  if (assistantIndex === -1 || assistantIndex > userIndex) return bubbles;
  const user = bubbles[userIndex];
  const rest = bubbles.filter((_, index) => index !== userIndex);
  const target = rest.findIndex(
    (bubble) => bubble.role === "assistant" && bubble.assistantId?.startsWith(prefix) === true,
  );
  return target === -1 ? bubbles : [...rest.slice(0, target), user, ...rest.slice(target)];
}

function insertByStatePosition(state: ChatState, rebuilt: Bubble[], liveBubble: Bubble): Bubble[] {
  const liveIndex = state.bubbles.findIndex((bubble) => bubble.id === liveBubble.id);
  if (liveIndex === -1) return [...rebuilt, liveBubble];
  let insertAt = rebuilt.length;
  for (let index = 0; index < rebuilt.length; index += 1) {
    if (stateIndexOfBubble(state, rebuilt[index]) > liveIndex) {
      insertAt = index;
      break;
    }
  }
  return [...rebuilt.slice(0, insertAt), liveBubble, ...rebuilt.slice(insertAt)];
}

/** ページ取得時に実行中だったツールはページに載らず所有者が切れるため、ライブ側から補う */
function restoreSettledTools(
  state: ChatState,
  bubbles: Bubble[],
  liveId: number | null,
  pairs: Map<number, string>,
): Bubble[] {
  let next = bubbles;
  // 使った履歴 item を控えないと、同文の別応答へ同じ item のツールを複製する
  const used = new Set<number>();
  const indexById = new Map<number, number>();
  const indicesByEntryId = new Map<string, number[]>();
  const indicesByAssistantId = new Map<string, number[]>();
  const indicesByText = new Map<string, number[]>();
  const indexByUserSendId = new Map<string, number>();
  bubbles.forEach((bubble, index) => {
    indexById.set(bubble.id, index);
    if (bubble.role === "user" && bubble.sendId !== undefined && !indexByUserSendId.has(bubble.sendId)) {
      indexByUserSendId.set(bubble.sendId, index);
    }
    if (bubble.entryId === undefined) return;
    const entryIndices = indicesByEntryId.get(bubble.entryId) ?? [];
    entryIndices.push(index);
    indicesByEntryId.set(bubble.entryId, entryIndices);
    if (bubble.role !== "assistant") return;
    if (bubble.assistantId !== undefined) {
      const assistantIndices = indicesByAssistantId.get(bubble.assistantId) ?? [];
      assistantIndices.push(index);
      indicesByAssistantId.set(bubble.assistantId, assistantIndices);
    }
    const textIndices = indicesByText.get(bubble.text) ?? [];
    textIndices.push(index);
    indicesByText.set(bubble.text, textIndices);
  });
  // turnIndexOf を live ごとに走査しないための表。各 assistant の直前の user 送信IDを控える
  const turnSendIdByLiveId = new Map<number, string | undefined>();
  let currentTurnSendId: string | undefined;
  for (const bubble of state.bubbles) {
    if (bubble.role === "user") currentTurnSendId = bubble.sendId;
    else turnSendIdByLiveId.set(bubble.id, currentTurnSendId);
  }
  const firstUnused = (indices: number[] | undefined, fromEnd: boolean): number => {
    if (indices === undefined) return -1;
    if (fromEnd) {
      for (let i = indices.length - 1; i >= 0; i -= 1) {
        const index = indices[i];
        if (!used.has(index)) return index;
      }
      return -1;
    }
    for (const index of indices) {
      if (!used.has(index)) return index;
    }
    return -1;
  };
  for (const live of state.bubbles) {
    if (live.role !== "assistant" || live.entryId !== undefined || live.id === liveId) continue;
    if (indexById.has(live.id)) continue;
    const paired = pairs.get(live.id);
    let match = paired === undefined ? -1 : firstUnused(indicesByEntryId.get(paired), false);
    if (match === -1 && live.assistantId !== undefined) {
      match = firstUnused(indicesByAssistantId.get(live.assistantId), false);
    }
    if (match === -1 && live.assistantId === undefined) {
      // 応答IDが片方にしか無い旧データだけ、同一ターン内の本文一致へ縮退する。本文を持たない
      // バブル (ツールだけの host) は空文字の一致だけで別の item へ載せない
      if (live.text === "") continue;
      const turnSendId = turnSendIdByLiveId.get(live.id);
      const turnIndex = turnSendId === undefined ? -1 : (indexByUserSendId.get(turnSendId) ?? -1);
      if (turnIndex === -1) continue;
      const candidates = indicesByText.get(live.text);
      if (candidates !== undefined) {
        for (let i = candidates.length - 1; i >= 0; i -= 1) {
          const index = candidates[i];
          if (index <= turnIndex) break;
          if (used.has(index)) continue;
          match = index;
          break;
        }
      }
    }
    if (match === -1) continue;
    used.add(match);
    next = next.map((bubble, index) => (index === match ? mergeAssistantCard(live, bubble) : bubble));
  }
  return next;
}

/** 保存済み messages にライブの結末は載らないため、履歴ページ適用後も Done を残す */
function restoreUserTurnEnds(state: ChatState, bubbles: Bubble[]): Bubble[] {
  // 写す相手が居ない再同期で索引を作らないため、先に対象の live だけを取り出す
  const ended = state.bubbles.filter(
    (bubble): bubble is Bubble & { runDurationMs: number } =>
      bubble.role === "user" && bubble.runDurationMs !== undefined,
  );
  if (ended.length === 0) return bubbles;
  // sendId は先頭・本文は末尾の一致を使うため、索引にも同じ側の 1 件だけを控える
  const ids = new Set<number>();
  const indexBySendId = new Map<string, number>();
  const indexByText = new Map<string, number>();
  bubbles.forEach((bubble, index) => {
    ids.add(bubble.id);
    if (bubble.role !== "user") return;
    if (bubble.sendId !== undefined && !indexBySendId.has(bubble.sendId)) indexBySendId.set(bubble.sendId, index);
    indexByText.set(bubble.text, index);
  });
  // 一致のたびに map で配列を作り直すと、結末を持つ user の数だけ全バブルを走査し直すことになる
  const updates = new Map<number, { runDurationMs: number; runOutcome: RunOutcome | undefined }>();
  for (const live of ended) {
    if (ids.has(live.id)) continue;
    const match =
      live.sendId === undefined ? (indexByText.get(live.text) ?? -1) : (indexBySendId.get(live.sendId) ?? -1);
    if (match === -1) continue;
    updates.set(match, { runDurationMs: live.runDurationMs, runOutcome: live.runOutcome });
  }
  if (updates.size === 0) return bubbles;
  return bubbles.map((bubble, index) => {
    const update = updates.get(index);
    return update === undefined ? bubble : { ...bubble, ...update };
  });
}

/** 本文一致で寄せると同文の別応答を取り違えるため、応答IDがあるときはそれだけで対応付ける */
function mergeStreamingIntoHistory(
  state: ChatState,
  bubbles: Bubble[],
  pairs: Map<number, string>,
): { bubbles: Bubble[]; currentAssistantId: number | null; toolBubbleIds: Record<string, number> } {
  const liveId = state.currentAssistantId;
  const live = liveId === null ? undefined : state.bubbles.find((bubble) => bubble.id === liveId);
  if (live === undefined || state.runStatus !== "running") {
    const kept = restoreSettledTools(state, bubbles, liveId, pairs);
    return {
      bubbles: kept,
      currentAssistantId: liveId !== null && kept.some((bubble) => bubble.id === liveId) ? liveId : null,
      toolBubbleIds: toolBubbleIdsOf(kept),
    };
  }
  let matchIndex = -1;
  if (live.assistantId !== undefined) {
    // 応答IDがあるときは本文一致・位置推定を使わない (同本文の別応答を取り違えない)
    matchIndex = bubbles.findIndex(
      (bubble) =>
        bubble.role === "assistant" && bubble.entryId !== undefined && bubble.assistantId === live.assistantId,
    );
    if (matchIndex === -1) {
      // 両方に ID があるときに本文で寄せると別応答を取り違えるため、片方だけの旧データに限る
      let turnIndex = turnIndexOf(state, live.id, bubbles);
      if (turnIndex === -1) {
        // 今ターンの user が履歴に無いと本文一致の範囲が決まらないため、最後の user を境界にする
        for (let index = bubbles.length - 1; index >= 0; index -= 1) {
          if (bubbles[index].role === "user") {
            turnIndex = index;
            break;
          }
        }
      }
      if (turnIndex !== -1) {
        const candidates: number[] = [];
        for (let index = bubbles.length - 1; index > turnIndex; index -= 1) {
          const bubble = bubbles[index];
          if (bubble.role !== "assistant" || bubble.entryId === undefined || bubble.assistantId !== undefined) continue;
          if (bubble.text === "" || live.text === "") continue;
          if (bubble.text.startsWith(live.text) || live.text.startsWith(bubble.text)) candidates.push(index);
        }
        if (candidates.length === 1) matchIndex = candidates[0];
      }
    }
  } else {
    // 今ターンの開始 user より前の assistant へは寄せない (前ターンの同一文面を上書きしない)
    const turnIndex = turnIndexOf(state, live.id, bubbles);
    // 保存済みの同じ応答 (ライブの本文の先頭まで) を今ターンの範囲で探す。空の応答は完全一致だけを対象にする
    if (turnIndex !== -1) {
      for (let index = bubbles.length - 1; index > turnIndex; index -= 1) {
        const bubble = bubbles[index];
        if (bubble.role !== "assistant" || bubble.entryId === undefined) continue;
        if (state.closedAssistantTexts.includes(bubble.text)) continue;
        if (bubble.text === live.text || (bubble.text.length > 0 && live.text.startsWith(bubble.text))) {
          matchIndex = index;
          break;
        }
      }
    }
  }
  if (matchIndex === -1) {
    // 照合できない履歴マージでライブのカードが消えていても、今ターンの応答として残す (データを失わない)
    const base = bubbles.some((bubble) => bubble.id === liveId) ? bubbles : [...bubbles, live];
    const kept = restoreSettledTools(state, base, liveId, pairs);
    return { bubbles: kept, currentAssistantId: liveId, toolBubbleIds: toolBubbleIdsOf(kept) };
  }
  const mergedBubble = mergeAssistantCard(live, bubbles[matchIndex]);
  const next = restoreSettledTools(
    state,
    bubbles
      .map((bubble, index) => (index === matchIndex ? mergedBubble : bubble))
      .filter((bubble, index) => index === matchIndex || bubble.id !== liveId),
    liveId,
    pairs,
  );
  return { bubbles: next, currentAssistantId: liveId, toolBubbleIds: toolBubbleIdsOf(next) };
}

/** ツールカードの持ち主の索引。同じ call は最初に持つバブルだけを指す */
function toolBubbleIdsOf(bubbles: Bubble[]): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const bubble of bubbles) {
    for (const card of bubble.tools) {
      if (ids[card.id] === undefined) ids[card.id] = bubble.id;
    }
  }
  return ids;
}

/**
 * 本文なし応答のカードを、同じターンで次に確定した本文の応答へ寄せる。履歴の投影は本文なし応答の
 * ツールを同ターン内の次の表示メッセージへ繰り上げるので、ライブが古い持ち主のままだと同じ記録を
 * 読み直した表示と所有者が食い違う。本文が確定する前と、本文が現れないターンでは動かさない。
 */
function carryToolCardsToAnswers(
  bubbles: Bubble[],
  keepId: number | null,
): { bubbles: Bubble[]; dropped: Set<number> } {
  const targets = new Map<number, number>();
  let owners: Bubble[] = [];
  for (const bubble of bubbles) {
    if (bubble.role === "user") {
      owners = [];
      continue;
    }
    if (bubble.role !== "assistant") continue;
    // 確定した本文だけを繰り上げ先にする。ストリーミング中に移すと、保存前の再読み込みで戻る
    if (bubble.text !== "" && (bubble.settled === true || bubble.entryId !== undefined)) {
      for (const owner of owners) targets.set(owner.id, bubble.id);
      owners = [];
      continue;
    }
    if (bubble.text === "" && bubble.tools.length > 0) owners.push(bubble);
  }
  if (targets.size === 0) return { bubbles, dropped: new Set() };
  const carried = new Map<number, ToolCard[]>();
  const bubbleById = new Map(bubbles.map((bubble) => [bubble.id, bubble]));
  // 移し先に既にある call は足さない (履歴が assistant_end を追い越すと履歴由来のカードが先に載る)
  const knownOf = new Map<number, Set<string>>();
  const knownOn = (targetId: number): Set<string> => {
    const known = knownOf.get(targetId);
    if (known !== undefined) return known;
    const ids = new Set(bubbleById.get(targetId)?.tools.map((card) => card.id) ?? []);
    knownOf.set(targetId, ids);
    return ids;
  };
  for (const [ownerId, targetId] of targets) {
    const owner = bubbleById.get(ownerId);
    if (owner === undefined) continue;
    const known = knownOn(targetId);
    const moved = owner.tools.filter((card) => {
      if (known.has(card.id)) return false;
      known.add(card.id);
      return true;
    });
    if (moved.length === 0) continue;
    carried.set(targetId, [...(carried.get(targetId) ?? []), ...moved]);
  }
  const dropped = new Set<number>();
  const next: Bubble[] = [];
  for (const bubble of bubbles) {
    const moved = carried.get(bubble.id);
    if (moved !== undefined) {
      // 投影と同じく、繰り上げ分をこの応答の part より先に並べる
      next.push({ ...bubble, tools: [...moved, ...bubble.tools] });
      continue;
    }
    if (targets.has(bubble.id)) {
      // カードを移した本文なし応答は、履歴 item / 導出行 / 結末を持つときだけ器として残す
      if (
        bubble.id === keepId ||
        bubble.entryId !== undefined ||
        bubble.skillLoads.length > 0 ||
        bubble.turnEnd !== undefined
      ) {
        next.push({ ...bubble, tools: [] });
      } else {
        dropped.add(bubble.id);
      }
      continue;
    }
    next.push(bubble);
  }
  return { bubbles: next, dropped };
}

/** 繰り上げの結果を状態へ写す。消したバブルの補完先を指したままにしない */
function withCarriedToolCards(state: ChatState): ChatState {
  const { bubbles, dropped } = carryToolCardsToAnswers(state.bubbles, state.currentAssistantId);
  const currentDropped = state.currentAssistantId !== null && dropped.has(state.currentAssistantId);
  return {
    ...state,
    bubbles,
    toolBubbleIds: toolBubbleIdsOf(bubbles),
    currentAssistantId: currentDropped ? null : state.currentAssistantId,
    currentAssistantKey: currentDropped ? undefined : state.currentAssistantKey,
    toolTargetAssistantId:
      state.toolTargetAssistantId !== undefined && dropped.has(state.toolTargetAssistantId)
        ? undefined
        : state.toolTargetAssistantId,
  };
}

/**
 * 完了ツールは本文なし応答から次の表示本文へ繰り上げて投影される。本文を持つ側を正としないと、
 * 再接続で合成したカードと投影先の両方に同じ call が出て、再読み込みと食い違う。
 */
function dedupeToolCards(
  bubbles: Bubble[],
  keepId: number | null,
): { bubbles: Bubble[]; toolBubbleIds: Record<string, number> } {
  const owners = new Map<string, Bubble>();
  for (const bubble of bubbles) {
    for (const card of bubble.tools) {
      const owner = owners.get(card.id);
      if (owner === undefined || (owner.text === "" && bubble.text !== "")) owners.set(card.id, bubble);
    }
  }
  const next: Bubble[] = [];
  for (const bubble of bubbles) {
    // 繰り上げや履歴の突き合わせで同じ応答に同じ call が 2 度載っても、カードは 1 枚にする
    const seen = new Set<string>();
    const tools = bubble.tools.filter((card) => {
      if (owners.get(card.id) !== bubble || seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
    if (tools.length === bubble.tools.length) {
      next.push(bubble);
      continue;
    }
    // ツールを失っただけの空の合成カードは残さない。履歴 item の id はページの連続性の基準なので残す
    const empty =
      bubble.role === "assistant" &&
      bubble.text === "" &&
      bubble.entryId === undefined &&
      bubble.skillLoads.length === 0 &&
      bubble.usage === undefined &&
      bubble.metrics === undefined &&
      bubble.turnEnd === undefined;
    if (empty && tools.length === 0 && bubble.id !== keepId) continue;
    next.push({ ...bubble, tools });
  }
  const toolBubbleIds: Record<string, number> = {};
  for (const bubble of next) {
    for (const card of bubble.tools) {
      if (toolBubbleIds[card.id] === undefined) toolBubbleIds[card.id] = bubble.id;
    }
  }
  return { bubbles: next, toolBubbleIds };
}

function applyHistoryMerge(state: ChatState, merged: HistoryMergeResult, page: HistoryPage): ChatState {
  const streaming = mergeStreamingIntoHistory(state, merged.bubbles, merged.pairs);
  const identity = runIdentityOf(state, streaming.bubbles);
  const normalized = normalizeInitialSend(streaming.bubbles, identity.initialSendId);
  const ordered = orderInitialUser(normalized, identity.runId, identity.initialSendId);
  const carried = carryToolCardsToAnswers(ordered, streaming.currentAssistantId);
  const deduped = dedupeToolCards(carried.bubbles, streaming.currentAssistantId);
  return {
    ...state,
    bubbles: restoreLiveHost(state, restoreUserTurnEnds(state, deduped.bubbles)),
    nextId: merged.nextId,
    toolBubbleIds: deduped.toolBubbleIds,
    currentAssistantId: streaming.currentAssistantId,
    currentAssistantKey:
      streaming.currentAssistantId === null
        ? undefined
        : ordered.find((bubble) => bubble.id === streaming.currentAssistantId)?.assistantId,
    ...(state.toolTargetAssistantId !== undefined && carried.dropped.has(state.toolTargetAssistantId)
      ? { toolTargetAssistantId: undefined }
      : {}),
    dividers: merged.markers,
    pendingEchoIds: merged.pendingEchoIds,
    sessionId: page.sessionId,
    history: {
      supported: true,
      unsupported: false,
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

function insertRunUser(
  state: ChatState,
  text: string,
  at: number | undefined,
  runId: string | undefined,
  initialSendId: string | undefined,
): ChatState {
  const bubble: Bubble = {
    id: state.nextId,
    role: "user",
    text,
    tools: [],
    skillLoads: [],
    at,
    ...(runId === undefined ? {} : { runId }),
    ...(initialSendId === undefined ? {} : { sendId: initialSendId }),
  };
  let insertAt = state.bubbles.length;
  const prefix = runId === undefined ? undefined : `${runId}:`;
  if (prefix !== undefined) {
    const early = state.bubbles.findIndex(
      (item) => item.role === "assistant" && item.assistantId?.startsWith(prefix) === true,
    );
    if (early !== -1) insertAt = early;
  }
  if (insertAt === state.bubbles.length && state.currentAssistantId !== null) {
    const current = state.bubbles.find((item) => item.id === state.currentAssistantId);
    if (current?.role === "assistant" && current.assistantId === undefined && current.settled !== true) {
      insertAt = state.bubbles.findIndex((item) => item.id === current.id);
    }
  }
  return {
    ...state,
    bubbles: [...state.bubbles.slice(0, insertAt), bubble, ...state.bubbles.slice(insertAt)],
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
function ensureAssistant(state: ChatState, at?: number, assistantKey?: string): ChatState {
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
    bubbles: withMeta.bubbles.map((bubble) =>
      bubble.id === bubbleId && assistantKey !== undefined ? { ...bubble, assistantId: assistantKey } : bubble,
    ),
    currentAssistantId: bubbleId,
    currentAssistantKey: assistantKey,
    toolTargetAssistantId: undefined,
    pendingUsage: undefined,
    pendingMetrics: undefined,
  };
}

/**
 * 応答IDが変わったら前のカードを閉じて新しいカードを開く。assistant_end を取りこぼしても
 * 次の delta が前の応答へ連結されないようにする
 */
function openAssistantForKey(state: ChatState, at: number | undefined, assistantKey: string | undefined): ChatState {
  if (assistantKey === undefined) return ensureAssistant(state, at);
  if (state.currentAssistantId !== null) {
    const current = state.bubbles.find((bubble) => bubble.id === state.currentAssistantId);
    if (current !== undefined && current.assistantId !== assistantKey) {
      return ensureAssistant(
        {
          ...state,
          bubbles: state.bubbles.map((bubble) => (bubble.id === current.id ? { ...bubble, settled: true } : bubble)),
          currentAssistantId: null,
          currentAssistantKey: undefined,
          toolTargetAssistantId: current.id,
        },
        at,
        assistantKey,
      );
    }
  }
  return ensureAssistant(state, at, assistantKey);
}

/**
 * 閉じたばかりの応答へツールを足せるかを決める。応答IDが違えば別の応答なので、違うカードへは
 * 足さない (本文の追記先とツールの所有者が食い違う)。
 */
function closedToolTarget(state: ChatState, assistantKey: string | undefined): number | undefined {
  if (state.currentAssistantId !== null || state.toolTargetAssistantId === undefined) return undefined;
  const target = state.bubbles.find((bubble) => bubble.id === state.toolTargetAssistantId);
  if (target === undefined) return undefined;
  const sameOwner =
    assistantKey === undefined || target.assistantId === undefined || target.assistantId === assistantKey;
  return sameOwner ? target.id : undefined;
}

function attachCardTo(state: ChatState, card: ToolCard, bubbleId: number): ChatState {
  return {
    ...updateBubble(state, bubbleId, (bubble) => ({ ...bubble, tools: [...bubble.tools, card] })),
    toolBubbleIds: { ...state.toolBubbleIds, [card.id]: bubbleId },
  };
}

/**
 * 今の run の「ツールだけの host」(まだ本文 item を引き取っていないカード)。確定履歴は本文を持たない
 * 応答のツールを同ターンの次の表示可能な本文 item へ繰り上げるため、ライブもその本文 item が現れる
 * まで 1 枚のカードに溜める。待機・未送信のエコーは host の後ろに積まれることがあるので、配列の
 * 末尾ではなく host の印で引く (配列の位置をターン境界にしない)。
 */
function toolHostOf(bubbles: Bubble[]): Bubble | undefined {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (isToolHostBubble(bubble) && bubble.text === "") return bubble;
  }
  return undefined;
}

/**
 * run 中の host (本文 item を引き取った後も含む)。溜め先 (`toolHostOf`) と違い本文の有無を問わず、
 * 本文の補完先にしない対象を引く
 */
function markedToolHostOf(bubbles: Bubble[]): Bubble | undefined {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    if (isToolHostBubble(bubbles[index])) return bubbles[index];
  }
  return undefined;
}

/**
 * ツールカードを溜める host を用意する (既にあれば同じカードへ積む)。host は本文 item ではないので
 * 本文の補完先 (`currentAssistantId`) にはしない。代わりに `toolTargetAssistantId` を指し、以降の
 * ツールを閉じた応答として受けられるようにする。本文を持たない応答の usage / metrics は表示する行が
 * 無いため、ここで保留値を捨てて次の本文 item の数値と混ぜない。
 */
function ensureToolHost(state: ChatState, at?: number): { state: ChatState; id: number } {
  const existing = toolHostOf(state.bubbles);
  if (existing !== undefined) {
    return {
      state: { ...state, toolTargetAssistantId: existing.id, pendingUsage: undefined, pendingMetrics: undefined },
      id: existing.id,
    };
  }
  const appended = appendBubble(state, "assistant", "", at);
  const id = appended.nextId - 1;
  // 本文を持たない応答の usage / metrics は表示する item が無いので、host へ写さない。
  // run id は履歴の照合で使う (本文を持たないので、空文字の一致だけで別ターンへ対応付けさせない)
  return {
    state: {
      ...appended,
      bubbles: appended.bubbles.map((bubble) =>
        bubble.id === id
          ? {
              ...bubble,
              host: true as const,
              ...(state.currentRunId === undefined ? {} : { runId: state.currentRunId }),
            }
          : bubble,
      ),
      toolTargetAssistantId: id,
      pendingUsage: undefined,
      pendingMetrics: undefined,
    },
    id,
  };
}

/** assistant_end を取りこぼしても、次の応答のツールを前の応答へ混ぜない (本文の補完先も外す) */
function closeCurrentAssistant(state: ChatState): ChatState {
  if (state.currentAssistantId === null) return state;
  const id = state.currentAssistantId;
  return {
    ...state,
    bubbles: state.bubbles.map((bubble) => (bubble.id === id ? { ...bubble, settled: true } : bubble)),
    currentAssistantId: null,
    currentAssistantKey: undefined,
    toolTargetAssistantId: id,
  };
}

/**
 * host を次の表示可能な本文 item にする。確定履歴の投影は本文を持つ item にツールを繰り上げるので、
 * 同じカード (同じ id) のまま `assistantId` と本文だけを足せば、ライブと確定後でヘッダーの位置・
 * 高さ・件数・プレビューが変わらない。host の印は run が終わるまで残す: 本文 item を引き取った後も
 * そのターンの一部で、`run_end` までは実行中のカードとコピーを出さない。
 */
function adoptToolHost(state: ChatState, assistantKey: string): ChatState | undefined {
  const host = toolHostOf(state.bubbles);
  if (host === undefined) return undefined;
  // run が変わっていたら (断絶中の run 切替を resync で知らないまま採用した)
  // 前の run の控えは引き継がない。同じ run の採用なら積む
  const runId = state.currentRunId ?? runIdOfAssistantId(assistantKey);
  const kept = state.liveHostRunId === runId ? state.liveHostAssistantIds : [];
  return {
    ...state,
    bubbles: state.bubbles.map((bubble) => (bubble.id === host.id ? { ...bubble, assistantId: assistantKey } : bubble)),
    currentAssistantId: host.id,
    currentAssistantKey: assistantKey,
    toolTargetAssistantId: undefined,
    liveHostAssistantIds: [...new Set([...kept, assistantKey])],
    liveHostRunId: runId,
  };
}

/** 応答ID (`<runId>:<seq>`) から run id を引く。形式が違う旧データは undefined */
function runIdOfAssistantId(assistantId: string): string | undefined {
  const separator = assistantId.lastIndexOf(":");
  return separator > 0 ? assistantId.slice(0, separator) : undefined;
}

/**
 * host の控えが payload の run のものか。どちらかが不明 (旧サーバー / run を持たない payload) な
 * ときは run の変更を判定できないため保持する。判定できるときに違えば、前の run の完了済み host を
 * live に戻さない
 */
function hostLedgerBelongsToRun(ledgerRunId: string | undefined, runId: string | undefined): boolean {
  return ledgerRunId === undefined || runId === undefined || ledgerRunId === runId;
}

/**
 * run が変わったときに、前の run の host を確定する。live の印を外さないと、履歴ページが届くまでの
 * 間だけ古いターンのコピーと実行中の行が隠れたままになる
 */
function settleDroppedHosts(bubbles: Bubble[], assistantIds: readonly string[]): Bubble[] {
  if (assistantIds.length === 0) return bubbles;
  const dropped = new Set(assistantIds);
  let changed = false;
  const next = bubbles.map((bubble) => {
    if (!isToolHostBubble(bubble) || bubble.assistantId === undefined || !dropped.has(bubble.assistantId)) {
      return bubble;
    }
    changed = true;
    return { ...bubble, host: undefined, settled: true };
  });
  return changed ? next : bubbles;
}

/**
 * ページ再構築の後に、本文 item を引き取った host の印を戻す。mergeHistoryPage は履歴 item から
 * バブルを組み直し、host は履歴に載らないため、対応付けが済んだ host は live の照合対象から外れて
 * 印を失う。run の終端 (run_end / run_start) までは同じ応答を host として扱い、実行中の行とコピーを
 * 再構築の後に出さない。応答が履歴から消えていれば何もしない。
 */
function restoreLiveHost(state: ChatState, bubbles: Bubble[]): Bubble[] {
  if (state.liveHostAssistantIds.length === 0) return bubbles;
  const hosts = new Set(state.liveHostAssistantIds);
  let changed = false;
  const next = bubbles.map((bubble) => {
    if (bubble.role !== "assistant" || bubble.assistantId === undefined) return bubble;
    if (!hosts.has(bubble.assistantId) || isToolHostBubble(bubble)) return bubble;
    changed = true;
    return { ...bubble, host: true as const };
  });
  return changed ? next : bubbles;
}

/** host のカードを所有者 (本文を持たない応答) ごとに分ける。順序はカードが届いた順 */
function toolCardGroups(
  tools: readonly ToolCard[],
  runTools: ChatState["runTools"],
): { assistantId?: string; cards: ToolCard[] }[] {
  const groups: { assistantId?: string; cards: ToolCard[] }[] = [];
  for (const card of tools) {
    const owner = runTools[card.id]?.assistantId;
    const group = groups.find((entry) => entry.assistantId === owner);
    if (group === undefined) groups.push({ assistantId: owner, cards: [card] });
    else group.cards.push(card);
  }
  return groups.length === 0 ? [{ cards: [] }] : groups;
}

/**
 * run が終わったターンの host を、確定履歴の item 境界へ揃えて確定する。投影は本文を持たない応答を
 * それぞれ 1 item (自分のツールだけを持つ) にするため、複数応答のツールを 1 枚にまとめたまま残すと
 * resync / F5 でヘッダーの数・件数・位置が変わってしまう。本文 item を引き取った host はそのまま
 * 1 item として確定し、ライブの印 (host) を外す。
 */
function settleToolHosts(state: ChatState): ChatState {
  if (!state.bubbles.some(isToolHostBubble)) return state;
  const bubbles: Bubble[] = [];
  let nextId = state.nextId;
  for (const bubble of state.bubbles) {
    if (!isToolHostBubble(bubble)) {
      bubbles.push(bubble);
      continue;
    }
    const groups =
      bubble.text === ""
        ? toolCardGroups(bubble.tools, state.runTools)
        : [{ assistantId: bubble.assistantId, cards: bubble.tools }];
    groups.forEach((group, index) => {
      bubbles.push({
        ...bubble,
        // 1 枚目は元のバブル (DOM の位置) をそのまま使う
        id: index === 0 ? bubble.id : nextId++,
        settled: true,
        host: undefined,
        assistantId: group.assistantId,
        tools: group.cards,
      });
    });
  }
  return { ...state, bubbles, nextId, toolBubbleIds: toolBubbleIdsOf(bubbles) };
}

/**
 * 履歴 API の最新ページが届くまでの初期表示に使う payload.messages の上限。全量を組むと長い会話で
 * バブル数と merge が履歴長に比例して増え、最初のページ適用が固まるため、直近だけを即時表示する。
 * 古い側はスクロール時のページ取得に委ね、履歴 API が無いときだけ全量で組み直す。
 */
export const LEGACY_INITIAL_MAX_MESSAGES = 200;

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
      legacy: true,
      role: message.role,
      text: message.text,
      ...(message.assistantId !== undefined ? { assistantId: message.assistantId } : {}),
      ...(message.sendId !== undefined ? { sendId: message.sendId } : {}),
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
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
 * 回答が settle した直後の活動表示。待機の文言は status (由来つき) と resync (由来なし) のどちらでも
 * 入り、次に届くまで残るため、回答待ちが無くなった時点で落とす。
 */
function clearQuestionActivity(state: ChatState): ChatState {
  const waiting = state.activityState === "question" || state.activity === ASK_USER_WAITING_TEXT;
  if (!waiting || pendingAskUserQuestionCount(state.runTools, state.runStatus) > 0) {
    return state;
  }
  return { ...state, activity: "実行中…", activityState: undefined };
}

/**
 * 本文を持たない応答は履歴 item に現れないため、所有者IDのカードを合成しないと ID 付きの call が
 * 結び付かず、再接続でツールカードが消える (本文の追記先は変えない)。
 */
function appendOwnedAssistant(state: ChatState, ownerKey: string | undefined): { state: ChatState; id: number } {
  const id = state.nextId;
  // 履歴 item を持たない応答なので、payload が応答単位で配るメタ情報だけを写す (run の開始時刻や
  // 再読み込み時刻で代用すると、生成時間の行が別の値になる)。無い項目はそのまま欠ける
  const meta = ownerKey === undefined ? undefined : state.assistantMeta[ownerKey];
  const usage = state.pendingUsage ?? meta?.usage;
  const metrics = state.pendingMetrics ?? meta?.metrics;
  const bubble: Bubble = {
    id,
    role: "assistant",
    text: "",
    tools: [],
    skillLoads: [],
    settled: true,
    ...(ownerKey === undefined ? {} : { assistantId: ownerKey }),
    ...(meta?.at === undefined ? {} : { at: meta.at }),
    ...(usage === undefined ? {} : { usage }),
    ...(metrics === undefined ? {} : { metrics }),
  };
  return {
    state: {
      ...state,
      bubbles: [...state.bubbles, bubble],
      nextId: id + 1,
      pendingUsage: undefined,
      pendingMetrics: undefined,
    },
    id,
  };
}

/**
 * run 側のツール状態を現在ターンの assistant バブルへ反映する。補完先が無いときは補完せず
 * 保持だけする (保留)。ページを組み直す位置から呼ぶので、ID で突き合わせてべき等にする。
 * focus は true のときだけ currentAssistantId を補完先へ向ける。呼び出し側は実行中かどうかで決める
 * (完了したターンを指すと、そのバブルが live 扱いのままになり履歴側のコピーが戻らない)。
 */
function attachRunToolCards(state: ChatState, focus: boolean): ChatState {
  const calls = Object.values(state.runTools);
  if (calls.length === 0) return state;
  // 本文を持たない応答のカードは、所有者ごとの空カードを作らず今ターンの host へ溜める。確定履歴は
  // 同じターンの次の表示可能な本文 item へ繰り上げるので、その item が現れるまで持ち主を決めない
  for (const call of calls) {
    if (call.assistantId === undefined || state.toolBubbleIds[call.id] !== undefined) continue;
    const owned = state.bubbles.some(
      (bubble) => bubble.role === "assistant" && bubble.assistantId === call.assistantId,
    );
    if (owned) continue;
    if (isPendingAskUser(call)) {
      // 回答待ちの ask_user は本文も結果も無く履歴 item にならない。応答メタ (時刻 / usage) と
      // 応答IDを持つ空のカードを合成し、回答できる状態を再接続でも保つ
      state = appendOwnedAssistant(state, call.assistantId).state;
      continue;
    }
    const host = ensureToolHost(state);
    state = attachCardTo(host.state, toolCardOf(call), host.id);
  }
  // 開いている応答を優先し、無ければ assistant_end で閉じた応答へ付ける
  const existing = (id: number | null | undefined): id is number =>
    id !== undefined && id !== null && state.bubbles.some((bubble) => bubble.id === id);
  let targetId = existing(state.currentAssistantId)
    ? state.currentAssistantId
    : existing(state.toolTargetAssistantId)
      ? state.toolTargetAssistantId
      : currentTurnAssistantId(state.bubbles);
  // 本文も応答IDも持たない旧データの回答待ちでは補完先が無い。待機中は次のイベントが来ず
  // 自己回復しないので、ここだけ assistant バブルを合成する
  if (targetId === undefined) {
    if (!calls.some(isPendingAskUser)) return state;
    const appended = appendOwnedAssistant(state, undefined);
    state = appended.state;
    targetId = appended.id;
  }
  const attached = attachToolCalls(state, targetId, calls);
  // 閉じた応答を focus で開き直すと、次の delta がそのカードへ連結される。host は本文 item ではないので
  // 本文の補完先にしない (次の本文は host を引き取って同じカードを item にする)
  const target = state.bubbles.find((bubble) => bubble.id === targetId);
  const hostId = markedToolHostOf(state.bubbles)?.id;
  const focusable =
    targetId !== state.toolTargetAssistantId && target !== undefined && target.settled !== true && targetId !== hostId;
  return focus && focusable
    ? { ...attached, currentAssistantId: targetId, currentAssistantKey: target?.assistantId }
    : attached;
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
    // 要求元の応答IDが分かるカードは、その応答が見つかるまで置かない (別の応答へ移さない)
    const ownerId =
      call.assistantId === undefined
        ? undefined
        : next.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === call.assistantId)?.id;
    if (call.assistantId !== undefined && ownerId === undefined) continue;
    const targetId = ownerId ?? bubbleId;
    next = {
      ...updateBubble(next, targetId, (bubble) => ({ ...bubble, tools: [...bubble.tools, card] })),
      toolBubbleIds: { ...next.toolBubbleIds, [call.id]: targetId },
    };
  }
  return next;
}

/** 送信IDが結び付く前に届いた待機位置を、より新しい状態が無い分だけ残す */
function pruneQueuedSnapshots(
  snapshots: ChatState["queuedSnapshots"],
  pendingSends: PendingSend[] | undefined,
): ChatState["queuedSnapshots"] {
  if (pendingSends === undefined) return snapshots;
  const waiting = new Map(
    pendingSends
      .filter((send) => send.state === "queued" || send.state === "steering")
      .map((send) => [send.sendId, send] as const),
  );
  let next: ChatState["queuedSnapshots"] = snapshots;
  for (const [sendId, snapshot] of Object.entries(snapshots)) {
    const send = waiting.get(sendId);
    if (send === undefined) {
      if (next === snapshots) next = { ...snapshots };
      delete next[sendId];
      continue;
    }
    const position = send.position ?? snapshot.position;
    if (position !== snapshot.position) {
      if (next === snapshots) next = { ...snapshots };
      next[sendId] = { position };
    }
  }
  return next;
}

/** 送信IDが確定した / より新しい状態が届いた送信の待機位置を落とす */
function withoutQueuedSnapshots(
  snapshots: ChatState["queuedSnapshots"],
  sendIds: readonly string[],
): ChatState["queuedSnapshots"] {
  let next = snapshots;
  for (const sendId of sendIds) {
    if (next[sendId] === undefined) continue;
    if (next === snapshots) next = { ...snapshots };
    delete next[sendId];
  }
  return next;
}

/** payload.messages が既に含む応答へ、ライブのテキストを二重に積まない */
function trimStreamedMessages(bubbles: Bubble[], streaming: Bubble | undefined): Bubble[] {
  if (streaming === undefined) return bubbles;
  const last = bubbles[bubbles.length - 1];
  if (last?.role !== "assistant") return bubbles;
  // 投影の本文はストリーミングの累積と一致する (マスク済み)。一致しなければ投影を正とする
  if (last.text !== streaming.text && !streaming.text.startsWith(last.text)) return bubbles;
  return bubbles.slice(0, -1);
}

function sendStateOf(send: PendingSend): Pick<Bubble, "queued" | "queuedState" | "queuePosition" | "runId"> {
  if (send.state === "queued" || send.state === "steering") {
    return {
      queued: true,
      queuedState: send.state,
      ...(send.position === undefined ? {} : { queuePosition: send.position }),
      ...(send.runId === undefined ? {} : { runId: send.runId }),
    };
  }
  // running / unsent は待機一覧の対象外。実行へ割り当て済みなら run id を写す
  return {
    queued: undefined,
    queuedState: undefined,
    queuePosition: undefined,
    ...(send.runId === undefined ? {} : { runId: send.runId }),
  };
}

/**
 * payload.pendingSends (202 で受理したがまだ entry になっていない送信) をバブル列へ写す。
 * `unsent` は pending を外して「未送信」へ切り替え、`queued` / `running` は受理済みの pending として
 * 保つ (別タブの再送中に表示から消さない)。手元にバブルが無い分は末尾へ足す (履歴の初回応答前でも
 * 失わない)。一覧から消えた未送信バブルは、別タブの再送 / 破棄で記録が消えたものとして落とす。
 * `undefined` (旧サーバー) は現状維持。payload に載った送信は停止の控え (`clearedSendIds`) から外す。
 * 待機の表示は payload が正で、一覧から消えた run の待機も解除する (entry が保存された / 実行が始まった)。
 */
function applyPendingSends(
  bubbles: Bubble[],
  pendingEchoIds: number[],
  nextId: number,
  clearedSendIds: string[],
  pendingSends: PendingSend[] | undefined,
): { bubbles: Bubble[]; pendingEchoIds: number[]; nextId: number; clearedSendIds: string[] } {
  if (pendingSends === undefined) return { bubbles, pendingEchoIds, nextId, clearedSendIds };
  const bySendId = new Map(pendingSends.map((send) => [send.sendId, send]));
  const pending = new Set(pendingEchoIds);
  const seen = new Set<string>();
  const next: Bubble[] = [];
  let cursor = nextId;
  for (const bubble of bubbles) {
    // 送信IDを持たないバブル (旧サーバー) は run id でも突き合わせる
    const send =
      bubble.sendId !== undefined
        ? bySendId.get(bubble.sendId)
        : pendingSends.find((candidate) => candidate.runId !== undefined && candidate.runId === bubble.runId);
    const key = send?.sendId ?? bubble.sendId;
    if (send === undefined) {
      if (bubble.sendId === undefined && bubble.runId === undefined) {
        next.push(bubble);
        continue;
      }
      // 一覧に無い = 保存済みか破棄済み。未送信のバブルはここで落とす (保存済みは entry が担う)
      if (bubble.unsent === true) continue;
      next.push({ ...bubble, ...QUEUE_CLEARED });
      continue;
    }
    if (key !== undefined) seen.add(key);
    if (send.state === "unsent") {
      pending.delete(bubble.id);
      next.push({
        ...bubble,
        ...(bubble.sendId === undefined && key !== undefined ? { sendId: key } : {}),
        unsent: true,
        accepted: false,
        confirmed: false,
        ...CLEARED_TURN_END,
        ...QUEUE_CLEARED,
      });
      continue;
    }
    // 実行中 / 待機中。未送信の表示を戻し、entry が載ったときの吸収に載せる
    if (bubble.entryId === undefined) pending.add(bubble.id);
    next.push({
      ...bubble,
      unsent: false,
      accepted: true,
      confirmed: true,
      ...(bubble.sendId === undefined && key !== undefined ? { sendId: key } : {}),
      ...sendStateOf(send),
    });
  }
  for (const send of pendingSends) {
    if (seen.has(send.sendId)) continue;
    const id = cursor++;
    if (send.state === "unsent") {
      next.push({
        id,
        role: "user",
        text: send.text,
        tools: [],
        skillLoads: [],
        at: send.at,
        sendId: send.sendId,
        ...(send.runId === undefined ? {} : { runId: send.runId }),
        unsent: true,
      });
      continue;
    }
    // 受理済み (待機中 / 実行中) もバブルを持たせる。履歴の初回応答前でも消さない
    pending.add(id);
    next.push({
      id,
      role: "user",
      text: send.text,
      tools: [],
      skillLoads: [],
      at: send.at,
      sendId: send.sendId,
      accepted: true,
      ...sendStateOf(send),
    });
  }
  return {
    bubbles: next,
    // pending から外した分を落とし、待機 / 実行中で新たに載せた分を末尾へ足す
    pendingEchoIds: [...pending],
    nextId: cursor,
    // payload が載せた送信は権威ある状態なので、停止の控えは不要
    clearedSendIds: clearedSendIds.filter((id) => !bySendId.has(id)),
  };
}

/**
 * 未送信へ戻す / 再送する分岐で、前のランの値を消す。表示導出は unsent を見て行を落とすが、値自体を
 * 持ち越すと再送後に古い所要時間が残る
 */
const CLEARED_TURN_END = { runDurationMs: undefined, runOutcome: undefined } as const;

/** 待機を抜けたバブルへ古い順位を残さない (表示の導出は queued だけを見る) */
const QUEUE_CLEARED = { queued: undefined, queuedState: undefined, queuePosition: undefined } as const;

/** run が終わったことを、その実行を開始した送信のバブルへだけ写す (追加入力へ複製しない) */
function attachTurnEnd(
  bubbles: Bubble[],
  runId: string,
  initialSendId: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
): Bubble[] {
  const target = (bubble: Bubble): boolean =>
    bubble.role === "user" && (initialSendId !== undefined ? bubble.sendId === initialSendId : bubble.runId === runId);
  return bubbles.map((bubble) =>
    target(bubble) ? { ...bubble, runDurationMs: durationMs, runOutcome: outcome } : bubble,
  );
}

function attachAssistantTurnEnd(
  bubbles: Bubble[],
  runId: string | undefined,
  initialSendId: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
  currentAssistantId: number | null,
): Bubble[] {
  if (runId === undefined) return bubbles;
  const prefix = `${runId}:`;
  const initialIndex =
    initialSendId === undefined
      ? -1
      : bubbles.findIndex((bubble) => bubble.role === "user" && bubble.sendId === initialSendId);
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (bubble.role !== "assistant" || bubble.text === "") continue;
    if (bubble.assistantId !== undefined) {
      if (!bubble.assistantId.startsWith(prefix)) continue;
    } else if (bubble.id !== currentAssistantId && (initialIndex === -1 || index <= initialIndex)) {
      // ID の無い旧データで開始 user より前の応答へ結末を付けない
      continue;
    }
    // この実行の最後の本文応答がここ。既に結末があるなら前の応答へ遡らない (再同期のたびに
    // Done が増えると、実行単位で最後の本文応答に 1 回だけ、という契約が崩れる)
    if (bubble.turnEnd !== undefined) return bubbles;
    return bubbles.map((item, position) => (position === index ? { ...item, turnEnd: { outcome, durationMs } } : item));
  }
  return bubbles;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "newChat": {
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
    }

    case "resetHistory":
      // 会話 id は保ち、表示と履歴だけを捨てる (引き継ぎ後の payload が新しい世代を埋める)。
      // runEndSeq / sendSeq は単調に保ち、bubble id も再利用しない
      return {
        ...state,
        bubbles: [],
        dividers: [],
        toolBubbleIds: {},
        runTools: {},
        pendingEchoIds: [],
        clearedSendIds: [],
        queuedSnapshots: {},
        currentRunId: undefined,
        closedAssistantTexts: [],
        toolTargetAssistantId: undefined,
        liveToolIds: [],
        currentAssistantId: null,
        currentAssistantKey: undefined,
        // 履歴ごと入れ替わるので、前の履歴の host を復元しない
        liveHostAssistantIds: [],
        liveHostRunId: undefined,
        history: initialChatState.history,
        activity: "",
        activityState: undefined,
        // 履歴ごと入れ替わるので、前の履歴の操作の結果は持ち越さない
        notice: undefined,
        handoff: undefined,
        compactions: [],
        context: undefined,
      };

    case "resync": {
      const payload = action.payload;
      const status = payload.status || "idle";
      const sessionChanged = payload.sessionId !== state.sessionId;
      // 未作成チャットへ最初のセッションが届くのは切替ではない (ストリーミング中の応答を捨てない)
      const switchedSession = state.sessionId !== "" && sessionChanged;
      // 全履歴 API が使える間は payload.messages (有効コンテキスト) ではなく履歴ページを表示の正とする。
      // 取得済みの古いページを消さないため、ここでは表示を組み直さない (最新ページは resyncHistory が届く)。
      // ページ取得に一時的に失敗しても、取り込み済みの履歴がある間は payload.messages で組み直さない
      // (messages は有効コンテキストの投影で、圧縮後の残りが tool 呼び出しだけなら空にもなる)
      const keepHistory = !sessionChanged && (state.history.supported || holdsFetchedHistory(state));
      // 未確定の assistant を捨てるのは失敗試行の取り消し (context_edit) だけ。同じ run の継続
      // (追加入力の注入・保存確定など) で捨てると、続く delta が別カードになり live と履歴が食い違う
      const currentLive =
        state.currentAssistantId === null
          ? undefined
          : state.bubbles.find((bubble) => bubble.id === state.currentAssistantId);
      const payloadRunPrefix = payload.run?.id === undefined ? undefined : `${payload.run.id}:`;
      const currentForPayloadRun =
        currentLive !== undefined &&
        (state.currentRunId !== undefined
          ? state.currentRunId === payload.run?.id
          : payloadRunPrefix !== undefined && currentLive.assistantId?.startsWith(payloadRunPrefix) === true);
      const resumingRun =
        !switchedSession &&
        payload.resyncReason === undefined &&
        status === "running" &&
        payload.run?.id !== undefined &&
        currentForPayloadRun;
      const streaming = resumingRun ? currentLive : undefined;
      // run_end を取りこぼすと未保存の現在応答が消えるため、終端 payload でも残す
      const terminalLive =
        !switchedSession &&
        payload.resyncReason === undefined &&
        status !== "running" &&
        payload.run !== null &&
        payload.run !== undefined &&
        currentForPayloadRun &&
        currentLive?.role === "assistant"
          ? currentLive
          : undefined;
      const legacyMessages = payload.messages ?? [];
      const legacy = keepHistory
        ? null
        : historyToBubbles(
            state.nextId,
            state.history.unsupported ? legacyMessages : legacyMessages.slice(-LEGACY_INITIAL_MAX_MESSAGES),
          );
      // 初期 legacy を組み直すときは、旧 legacy をライブとして持ち越さない (全量復元で重複させる)
      const live = state.bubbles.filter(
        (bubble) => bubble.entryId === undefined && (legacy === null || bubble.legacy !== true),
      );
      // 失敗試行は payload.messages の投影から外れている。残す応答をテキストで判断できない
      // ときは取り消しを優先する (投影に無い閉じたカードを残さない)
      const projectedAssistants = (payload.messages ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => message.text);
      let failedAttempt: Bubble | undefined;
      if (payload.resyncReason === "attempt_discarded") {
        for (let index = live.length - 1; index >= 0; index -= 1) {
          const bubble = live[index];
          if (bubble.role !== "assistant") continue;
          if (
            projectedAssistants.some(
              (text) => text === bubble.text || (bubble.text !== "" && text.startsWith(bubble.text)),
            )
          ) {
            continue;
          }
          failedAttempt = bubble;
          break;
        }
      }
      // 確定済みのライブバブル (前の run の応答 / 送信エコー) は、履歴ページが届くまで残す
      const keptLive = live
        .filter(
          (bubble) =>
            bubble.id !== failedAttempt?.id &&
            (bubble.role === "user" ||
              bubble.settled === true ||
              bubble.id === streaming?.id ||
              bubble.id === terminalLive?.id),
        )
        .map((bubble) => (bubble.id === terminalLive?.id ? { ...bubble, settled: true } : bubble));
      // payload.messages の assistant は保存済み = 閉じた応答。開いている扱いにすると次の delta が連結される
      let rebuilt: Bubble[] = [];
      let streamingMerged = false;
      if (legacy !== null) {
        rebuilt = legacy.bubbles.map((bubble) => (bubble.role === "assistant" ? { ...bubble, settled: true } : bubble));
        // 履歴を持たない会話でも、確定済みの応答と実行中のツールカードを再構成で落とさない
        if (!switchedSession) {
          // 状態順のまま append すると user が応答の後ろへ出るため、payload の順を基準にする
          for (const liveBubble of keptLive) {
            if (liveBubble.role !== "user") continue;
            let userMatch = -1;
            if (liveBubble.sendId !== undefined) {
              userMatch = rebuilt.findIndex((bubble) => bubble.role === "user" && bubble.sendId === liveBubble.sendId);
            } else {
              let lastUser = -1;
              for (let index = rebuilt.length - 1; index >= 0; index -= 1) {
                if (rebuilt[index].role === "user") {
                  lastUser = index;
                  break;
                }
              }
              if (lastUser !== -1 && canonicalUserText(rebuilt[lastUser].text) === canonicalUserText(liveBubble.text)) {
                const liveIndex = state.bubbles.findIndex((bubble) => bubble.id === liveBubble.id);
                const liveNext = state.bubbles.slice(liveIndex + 1).find((bubble) => bubble.role === "assistant");
                const baseNext = rebuilt.slice(lastUser + 1).find((bubble) => bubble.role === "assistant");
                // 本文だけで寄せると前ターンの同名 user へ結末が移るため、直後の応答も一致させる
                const sameNext =
                  baseNext === undefined ||
                  (liveNext !== undefined &&
                    (liveNext.assistantId !== undefined && baseNext.assistantId !== undefined
                      ? liveNext.assistantId === baseNext.assistantId
                      : liveNext.text === baseNext.text));
                if (sameNext) userMatch = lastUser;
              }
            }
            if (userMatch === -1) {
              const initialForRun =
                payload.run?.id !== undefined &&
                payload.run.initialSendId !== undefined &&
                liveBubble.sendId === payload.run.initialSendId;
              const earlyAssistant = initialForRun
                ? rebuilt.findIndex(
                    (bubble) =>
                      bubble.role === "assistant" && bubble.assistantId?.startsWith(`${payload.run?.id}:`) === true,
                  )
                : -1;
              if (earlyAssistant === -1) {
                // 末尾へ append すると前ターンの応答より後ろに並ぶため、状態上の位置へ戻す
                rebuilt = insertByStatePosition(state, rebuilt, liveBubble);
              } else {
                rebuilt = [...rebuilt.slice(0, earlyAssistant), liveBubble, ...rebuilt.slice(earlyAssistant)];
              }
            } else {
              rebuilt = rebuilt.map((bubble, index) =>
                index === userMatch
                  ? {
                      ...bubble,
                      ...liveBubble,
                      text: bubble.text || liveBubble.text,
                      entryId: bubble.entryId,
                      ...(bubble.sendId !== undefined
                        ? { sendId: bubble.sendId }
                        : liveBubble.sendId === undefined
                          ? {}
                          : { sendId: liveBubble.sendId }),
                      ...(bubble.runId !== undefined
                        ? { runId: bubble.runId }
                        : liveBubble.runId === undefined
                          ? {}
                          : { runId: liveBubble.runId }),
                      ...(liveBubble.runDurationMs === undefined ? {} : { runDurationMs: liveBubble.runDurationMs }),
                      ...(liveBubble.runOutcome === undefined ? {} : { runOutcome: liveBubble.runOutcome }),
                    }
                  : bubble,
              );
            }
          }
          for (const liveBubble of keptLive) {
            if (liveBubble.role !== "assistant") continue;
            if (liveBubble.id === streaming?.id && liveBubble.assistantId === undefined) continue;
            let match = -1;
            if (liveBubble.assistantId !== undefined) {
              match = rebuilt.findIndex(
                (bubble) => bubble.role === "assistant" && bubble.assistantId === liveBubble.assistantId,
              );
              if (match === -1) {
                // 両方に ID があるときに本文で寄せると別応答を取り違えるため、片方だけの旧データに限る
                const turnIndex = turnIndexOf(state, liveBubble.id, rebuilt);
                if (turnIndex !== -1) {
                  const candidates: number[] = [];
                  for (let index = rebuilt.length - 1; index > turnIndex; index -= 1) {
                    const bubble = rebuilt[index];
                    if (bubble.role !== "assistant" || bubble.assistantId !== undefined) continue;
                    if (bubble.text === "" || liveBubble.text === "") continue;
                    if (bubble.text.startsWith(liveBubble.text) || liveBubble.text.startsWith(bubble.text)) {
                      candidates.push(index);
                    }
                  }
                  if (candidates.length === 1) match = candidates[0];
                }
              }
            } else {
              const turnIndex = turnIndexOf(state, liveBubble.id, rebuilt);
              const start = turnIndex === -1 ? 0 : turnIndex + 1;
              for (let index = rebuilt.length - 1; index >= start; index -= 1) {
                const bubble = rebuilt[index];
                if (
                  bubble.role === "assistant" &&
                  bubble.assistantId === undefined &&
                  bubble.text === liveBubble.text
                ) {
                  match = index;
                  break;
                }
              }
            }
            if (match === -1) {
              // 末尾へ append すると Done が次のターンへ移るため、状態上の位置へ戻す
              rebuilt = insertByStatePosition(state, rebuilt, liveBubble);
            } else {
              rebuilt = rebuilt.map((bubble, index) =>
                index === match ? mergeAssistantCard(liveBubble, bubble) : bubble,
              );
            }
            if (liveBubble.id === streaming?.id) streamingMerged = true;
          }
        }
      }
      const rebuiltWithStreaming =
        streaming === undefined || streaming.assistantId !== undefined
          ? rebuilt
          : trimStreamedMessages(rebuilt, streaming);
      const assembled = keepHistory
        ? [...state.bubbles.filter((bubble) => bubble.entryId !== undefined), ...keptLive]
        : [...rebuiltWithStreaming, ...(streaming === undefined || streamingMerged ? [] : [streaming])];
      const carried = carryToolCardsToAnswers(assembled, streaming?.id ?? null);
      const deduped = dedupeToolCards(carried.bubbles, streaming?.id ?? null);
      const bubbles = deduped.bubbles;
      const nextId = keepHistory ? state.nextId : (legacy?.nextId ?? state.nextId);
      const toolBubbleIds = deduped.toolBubbleIds;
      const retainedEchoIds = new Set(
        keepHistory ? keptLive.filter((bubble) => bubble.role === "user").map((bubble) => bubble.id) : [],
      );
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
      // 本文なしの未回答 ask_user は履歴 item にならないため、応答単位のメタ情報を控えておく
      const assistantMeta: Record<string, AssistantMeta> = {};
      for (const meta of payload.assistantMeta ?? []) assistantMeta[meta.assistantId] = meta;
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
        currentAssistantId: streaming?.id ?? null,
        currentAssistantKey: streaming?.assistantId,
        currentRunId: status === "running" ? payload.run?.id : undefined,
        toolBubbleIds,
        runTools,
        assistantMeta,
        // 履歴モードでは区切りを履歴ページが正とし、旧 payload では messages の index から復元する
        dividers: keepHistory ? state.dividers : legacyMarkers(payload.compactions ?? []),
        history: sessionChanged ? initialChatState.history : state.history,
        // 別の会話の停止で破棄された送信IDを持ち越さない
        clearedSendIds: sessionChanged ? [] : state.clearedSendIds,
        // 開始直後の演出は live 専用。payload が同じ run の実行中を示すときだけ残す
        startingRunId:
          status === "running" && payload.run?.id === state.startingRunId ? state.startingRunId : undefined,
        // ライブで観測したツール id も持ち越さない (古い id を新しい会話のライブ観測と誤読させない)
        liveToolIds: sessionChanged ? [] : state.liveToolIds,
        sessionId: payload.sessionId,
        title: payload.title,
        titleSummary: payload.titleSummary,
        runStatus: status,
        runStartedAt: status === "running" ? payload.run?.startedAt : undefined,
        // 圧縮の起点は payload の値だけ。終端 resync で status が抜ければ解除される
        compactionStartedAt: status === "compacting" ? payload.compactionStartedAt : undefined,
        queueDepth: payload.queueDepth || 0,
        activity: "",
        // 押した結果は会話を切り替えたときだけ捨てる (同じ会話の取り直しでは残す)
        notice: switchedSession ? undefined : state.notice,
        // 活動の由来は status イベントだけが入れる (復帰時の文言は状態ではなくお知らせなので持たない)
        activityState: undefined,
        sessionModel: payload.model,
        sessionThinkingLevel: payload.thinkingLevel,
        sessionAgentId: payload.agent?.id,
        sessionAgentName: payload.agent?.name,
        // 引き継ぎの状態も payload だけを正とする (旧サーバーは載せない = undefined)
        handoff: payload.handoff,
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
        // (折り返すと帯が行ごとに切れる)。run 自身の短いラベルを配る次の status で再開する。
        // 回答待ちの判定に status を使わないのは、resync ではリプレイされないため
        next = {
          ...next,
          activity:
            pendingAskUserQuestionCount(runTools, status) > 0
              ? ASK_USER_WAITING_TEXT
              : "実行中…（タブを閉じても処理は続きます）",
        };
      } else if (status === "compacting") next = { ...next, activity: "会話を整理中…" };
      else if (status === "queued") next = { ...next, activity: "" };
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
        next.clearedSendIds,
        payload.pendingSends,
      );
      const runOutcome = runOutcomeOf(status);
      const normalizedBubbles = normalizeInitialSend(applied.bubbles, payload.run?.initialSendId);
      let settledBubbles = orderInitialUser(normalizedBubbles, payload.run?.id, payload.run?.initialSendId);
      if (runOutcome !== undefined && payload.run?.endedAt !== undefined) {
        // ライブの run_end を観測済みならその値が正 (payload は run の所要時間を持たない)
        const initialUser = settledBubbles.find(
          (bubble) =>
            bubble.role === "user" &&
            (payload.run?.initialSendId === undefined
              ? bubble.runId === payload.run?.id
              : bubble.sendId === payload.run?.initialSendId),
        );
        const durationMs = initialUser?.runDurationMs ?? Math.max(0, payload.run.endedAt - payload.run.startedAt);
        const outcome = initialUser?.runOutcome ?? runOutcome;
        if (initialUser !== undefined && initialUser.runDurationMs === undefined) {
          settledBubbles = attachTurnEnd(
            settledBubbles,
            payload.run.id,
            payload.run.initialSendId,
            outcome,
            durationMs,
          );
        }
        // user の位置に依存すると Done が消えるため、run の最後の本文あり assistant へ直接付ける
        settledBubbles = attachAssistantTurnEnd(
          settledBubbles,
          payload.run.id,
          payload.run.initialSendId,
          outcome,
          durationMs,
          state.currentAssistantId,
        );
      }
      // host の控えは同じ run の再同期だけで使う。切断中に前の run が終わり次の run が始まると
      // `run_start` のリプレイなしで `resync` だけが届くため、run が変わっていたら前ターンの
      // 完了済み host を live に戻さない (コピーと実行中の行を隠したままにしない)
      const retainedHostIds =
        status === "running" && !switchedSession && hostLedgerBelongsToRun(state.liveHostRunId, payload.run?.id)
          ? state.liveHostAssistantIds
          : [];
      const droppedHostIds = state.liveHostAssistantIds.filter((id) => !retainedHostIds.includes(id));
      const hostSettled = settleDroppedHosts(settledBubbles, droppedHostIds);
      // run が終わっているターンの host は、確定履歴の item 境界 (本文なし応答ごと) へ揃えておく。
      // 実行中は本文 item が現れるかもしれないので、溜めたままにする
      const finalized =
        status === "running"
          ? { bubbles: hostSettled, nextId: applied.nextId, toolBubbleIds: next.toolBubbleIds }
          : settleToolHosts({ ...next, bubbles: hostSettled, nextId: applied.nextId });
      return {
        ...next,
        bubbles: finalized.bubbles,
        pendingEchoIds: applied.pendingEchoIds,
        nextId: finalized.nextId,
        toolBubbleIds: finalized.toolBubbleIds,
        clearedSendIds: applied.clearedSendIds,
        stateSeq: state.stateSeq + 1,
        closedAssistantTexts: switchedSession ? [] : state.closedAssistantTexts,
        // 実行中でなければ host は確定済み (settleToolHosts) なので、次のページ再構築で戻さない
        liveHostAssistantIds: retainedHostIds,
        liveHostRunId: retainedHostIds.length === 0 ? undefined : state.liveHostRunId,
        toolTargetAssistantId:
          !switchedSession &&
          state.toolTargetAssistantId !== undefined &&
          applied.bubbles.some((bubble) => bubble.id === state.toolTargetAssistantId)
            ? state.toolTargetAssistantId
            : undefined,
        // 別の会話の送信へ引き継がない
        queuedSnapshots: sessionChanged ? {} : pruneQueuedSnapshots(state.queuedSnapshots, payload.pendingSends),
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
      return attachRunToolCards(applyHistoryMerge(state, bundle, page), state.runStatus === "running");
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
        if (!latestMerge.gap) {
          return attachRunToolCards(applyHistoryMerge(state, latestMerge, pending), state.runStatus === "running");
        }
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
        if (!withPending.gap) {
          return attachRunToolCards(applyHistoryMerge(state, withPending, action.page), state.runStatus === "running");
        }
      }
      return attachRunToolCards(
        applyHistoryMerge(
          state,
          rebuildHistoryPage(bundle, pending, { live, pendingEchoIds: state.pendingEchoIds }),
          pending,
        ),
        state.runStatus === "running",
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

    case "historyUnsupported": {
      const next = { ...state, history: { ...state.history, supported: false, unsupported: true } };
      if (action.payload === undefined) return next;
      // ライブの本文・送信エコーや取得済みページがある間は、payload からの組み直しで消さない。
      // 未取得の legacy 表示だけを全量へ差し替える（次の resync でも unsupported を見て全量を組む）
      const hasLive = state.bubbles.some((bubble) => bubble.entryId === undefined && bubble.legacy !== true);
      if (hasLive || holdsFetchedHistory(state)) return next;
      // payload は古い実行状態を含み得るため、resync として適用せず表示に必要な分だけを写す
      const bundle = historyToBubbles(state.nextId, action.payload.messages ?? []);
      return {
        ...next,
        bubbles: bundle.bubbles,
        nextId: bundle.nextId,
        toolBubbleIds: bundle.toolBubbleIds,
        dividers: legacyMarkers(action.payload.compactions ?? []),
        compactions: action.payload.compactions ?? [],
        context: action.payload.context,
      };
    }

    case "runStart": {
      // 自分の送信を実行する run は run id で厳密に照合する。run id が分からないエコー (応答待ち) は
      // 照合せず保持し、別クライアントの同一文面 entry を誤って自分のものにしない。
      // 未送信 / 受理済みのバブルは、この run_start で「サーバーが実行を開始した」ことを確認済みに
      // する (楽観的に再送したバブルも含める。遅れて届いた失敗で未送信へ戻さない)。待機中
      // (`queued`) のバブルは送信応答だけが run id を付けているため、ここで合わせて拾う
      const started = state.bubbles.find(
        (bubble) =>
          bubble.entryId === undefined &&
          (action.initialSendId !== undefined
            ? bubble.sendId === action.initialSendId
            : action.runId !== undefined && bubble.runId === action.runId) &&
          (bubble.unsent === true || bubble.accepted === true || bubble.queued === true),
      );
      const startedBubble =
        started === undefined
          ? undefined
          : { ...started, unsent: false, accepted: true, confirmed: true, ...QUEUE_CLEARED };
      // 待機から実行に移った送信は末尾へ移す。実行中ターンがまだ assistant バブルを作っていない窓では、
      // 最初の delta がこの送信より後ろへ応答を積むため、ここで揃えないと実行に移った瞬間に前の応答の
      // 途中へ現れる (他のバブルの相対順は変えない)
      const moveStartedToEnd = started?.queued === true;
      const base =
        startedBubble === undefined
          ? state
          : {
              ...state,
              bubbles: moveStartedToEnd
                ? [...state.bubbles.filter((bubble) => bubble.id !== startedBubble.id), startedBubble]
                : state.bubbles.map((bubble) => (bubble.id === startedBubble.id ? startedBubble : bubble)),
              pendingEchoIds: state.pendingEchoIds.includes(startedBubble.id)
                ? state.pendingEchoIds
                : [...state.pendingEchoIds, startedBubble.id],
            };
      const promptBody = canonicalUserText(action.prompt);
      const echoIndex =
        action.initialSendId !== undefined
          ? base.pendingEchoIds.findIndex(
              (id) => base.bubbles.find((item) => item.id === id)?.sendId === action.initialSendId,
            )
          : action.runId !== undefined
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
          : action.initialSendId !== undefined || action.runId !== undefined
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
        next = known ? base : insertRunUser(base, action.prompt, action.at, action.runId, action.initialSendId);
      }
      // 前の run のツールだけの host は確定履歴の item 境界へ揃えて確定する (本文 item が来ないまま
      // run_end を取りこぼしていても、次の run のカードを前のターンの host へ混ぜない)
      const settled = settleToolHosts(next);
      return {
        ...settled,
        pendingEchoIds,
        // run_start の本文を控えておく。応答が遅れて届いたエコーを展開後の本文へ差し替えるのに使う
        runPrompts:
          action.runId === undefined
            ? next.runPrompts
            : rememberRunPrompt(next.runPrompts, action.runId, action.prompt),
        runInitialSendIds:
          action.runId === undefined || action.initialSendId === undefined
            ? next.runInitialSendIds
            : { ...next.runInitialSendIds, [action.runId]: action.initialSendId },
        currentAssistantId: null,
        currentAssistantKey: undefined,
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
        // 待機列の先頭が実行に移った瞬間だけ、リングを 1 回広げてチップを一瞬 `実行中` にする
        startingRunId: started?.queued === true ? action.runId : undefined,
        currentRunId: action.runId,
        toolTargetAssistantId: undefined,
        // 前の run の host を次の run のページ再構築で復元しない
        liveHostAssistantIds: [],
        liveHostRunId: undefined,
        closedAssistantTexts:
          action.runId !== undefined && action.runId === state.currentRunId ? state.closedAssistantTexts : [],
        stateSeq: state.stateSeq + 1,
        queuedSnapshots:
          action.initialSendId === undefined
            ? state.queuedSnapshots
            : withoutQueuedSnapshots(state.queuedSnapshots, [action.initialSendId]),
        // 実行が始まった送信は停止の控えから外す (遅れて届いた 202 で未送信へ戻さない)
        clearedSendIds: (() => {
          // 旧サーバーは開始送信IDを配らないため run id で縮退する
          const started = action.initialSendId ?? action.runId;
          return started === undefined ? next.clearedSendIds : next.clearedSendIds.filter((id) => id !== started);
        })(),
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
        // 実行中のターンの本文を積んでいる assistant バブルがあってもそこで受け続ける。ここで落とすと、
        // 次に届く delta がエコーより後ろの新しいバブルを作り、実行に移った送信が応答の途中に見える
        activity: "送信中…",
        activityState: undefined,
        pendingEchoIds: [...state.pendingEchoIds, echoId],
        // 送信の合図。post が失敗して echo を戻しても減らさない (最下部に居続ける方が都合が良い)
        sendSeq: state.sendSeq + 1,
      };
    }

    case "echoSendId": {
      // 送信応答の送信IDを、未対応付けの最古のエコーへ結び付ける (送信は直列なので順序で足りる)。
      // run_start が応答より先に届いていても、送信IDで自分の送信と厳密に対応付く
      const echoId = state.pendingEchoIds.find((id) => {
        const bubble = state.bubbles.find((item) => item.id === id);
        return bubble !== undefined && bubble.sendId === undefined;
      });
      if (echoId === undefined) return state;
      // payload が先にバブルを足していたら、ローカルのエコーへ寄せて重複を作らない
      // (同じ送信IDのバブルが 2 件残ると再送 / 破棄が二重に見える)
      const duplicate = state.bubbles.find(
        (bubble) => bubble.id !== echoId && bubble.sendId === action.sendId && bubble.entryId === undefined,
      );
      // run_start が応答より先に届いていれば、控えた本文でローカルエコーを差し替える
      const prompt = action.runId === undefined ? undefined : state.runPrompts[action.runId];
      // 待機の順位は応答が配る (押し込んだ直後の queueDepth)。run_start が先に届いた run は既に走って
      // いるので、遅れて届いた応答で待機中にはしない。payload が先に待機を配っていればそちらを採る。
      // 要求後に新しい状態 (resync / 終端 / 待機の変化) が届いていれば、古い待機スナップショットを捨てる
      const snapshotCurrent = action.stateSeq === undefined || action.stateSeq === state.stateSeq;
      // 同じ送信IDの queued が応答より先に届いていれば、その待機位置を応答へ引き継ぐ
      const carriedPosition = snapshotCurrent ? undefined : state.queuedSnapshots[action.sendId]?.position;
      const echoedPosition = snapshotCurrent ? action.queuePosition : carriedPosition;
      const queuePosition = duplicate?.queuePosition ?? (prompt === undefined ? echoedPosition : undefined);
      const queued = duplicate !== undefined ? duplicate.queued === true : queuePosition !== undefined;
      const consumedSnapshots = withoutQueuedSnapshots(state.queuedSnapshots, [action.sendId]);
      const withSendId = updateBubble(
        duplicate === undefined
          ? { ...state, queuedSnapshots: consumedSnapshots }
          : {
              ...state,
              bubbles: state.bubbles.filter((b) => b.id !== duplicate.id),
              queuedSnapshots: consumedSnapshots,
            },
        echoId,
        (bubble) => ({
          ...bubble,
          sendId: action.sendId,
          ...(action.runId === undefined ? {} : { runId: action.runId }),
          // 先にあったバブルの状態 (未送信 / 受理済み) を引き継ぐ
          ...(duplicate?.unsent === true ? { unsent: true, accepted: false, confirmed: false } : {}),
          ...(duplicate?.accepted === true
            ? { unsent: false, accepted: true, confirmed: duplicate.confirmed === true }
            : {}),
          ...(queued
            ? {
                queued: true,
                queuedState: duplicate?.queuedState ?? "queued",
                ...(queuePosition === undefined ? {} : { queuePosition }),
              }
            : {}),
          ...(prompt !== undefined ? { text: prompt } : {}),
        }),
      );
      const runPrompts = { ...state.runPrompts };
      if (action.runId !== undefined) delete runPrompts[action.runId];
      // 保存済みの entry が既にあれば、停止の控えより吸収を優先する (権威ある履歴を正とする)
      const target = withSendId.bubbles.find(
        (bubble) =>
          bubble.entryId !== undefined &&
          bubble.role === "user" &&
          (bubble.sendId === action.sendId ||
            // 旧サーバーの item は送信IDを持たないため、run の一致へ縮退する
            (bubble.sendId === undefined && action.runId !== undefined && bubble.runId === action.runId)),
      );
      if (target !== undefined) {
        return {
          ...withSendId,
          runPrompts,
          bubbles: withSendId.bubbles.filter((bubble) => bubble.id !== echoId),
          pendingEchoIds: withSendId.pendingEchoIds.filter((id) => id !== echoId),
          clearedSendIds: state.clearedSendIds.filter((id) => id !== action.sendId),
        };
      }
      // 停止で破棄された送信か、payload が未送信として配った送信なら、通常の送信済みに見せず
      // 未送信へ切り替える (重複して足されたバブルはローカルのエコーへ寄せる)
      if (state.clearedSendIds.includes(action.sendId) || duplicate?.unsent === true) {
        return {
          ...withSendId,
          runPrompts,
          bubbles: withSendId.bubbles.map((bubble) =>
            bubble.id === echoId
              ? { ...bubble, unsent: true, accepted: false, confirmed: false, ...CLEARED_TURN_END, ...QUEUE_CLEARED }
              : bubble,
          ),
          pendingEchoIds: withSendId.pendingEchoIds.filter((id) => id !== echoId),
          clearedSendIds: state.clearedSendIds.filter((id) => id !== action.sendId),
        };
      }
      return { ...withSendId, runPrompts };
    }

    case "resendUnsent": {
      // 未送信バブルを pending エコーへ戻す。本文はサーバー側が持つ生テキストを使うため、ここでは
      // 表示だけを通常の送信直後へ切り替える (送信IDは再送でも変わらない)
      const index = state.bubbles.findIndex((bubble) => bubble.unsent === true && bubble.sendId === action.sendId);
      if (index === -1) return state;
      const echo = state.bubbles[index];
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === index
            ? { ...bubble, unsent: false, accepted: true, confirmed: false, at: Date.now(), ...CLEARED_TURN_END }
            : bubble,
        ),
        // 再送でも送信と同じく、実行中のターンの本文を受けているバブルに積み続ける
        pendingEchoIds: [...state.pendingEchoIds, echo.id],
        // 停止で破棄された記録を再送するときは、未送信へ戻す控えを消す
        clearedSendIds: state.clearedSendIds.filter((id) => id !== action.sendId),
        activity: "送信中…",
        activityState: undefined,
        // 送信と同じく最下部への追従の合図を進める
        sendSeq: state.sendSeq + 1,
      };
    }

    case "resendFailed": {
      // 再送を受け付けてもらえなかった。通常の送信済みに見せないよう未送信へ戻す。ただし
      // payload / run_start でサーバーの受理を確認済みの run は実行されているので戻さない
      const index = state.bubbles.findIndex((bubble) => bubble.unsent === false && bubble.sendId === action.sendId);
      if (index === -1 || state.bubbles[index].confirmed === true) return state;
      const echo = state.bubbles[index];
      return {
        ...state,
        bubbles: state.bubbles.map((bubble, i) =>
          i === index ? { ...bubble, unsent: true, accepted: false, confirmed: false, ...CLEARED_TURN_END } : bubble,
        ),
        pendingEchoIds: state.pendingEchoIds.filter((id) => id !== echo.id),
      };
    }

    case "unsentDiscarded":
      return {
        ...state,
        bubbles: state.bubbles.filter((bubble) => !(bubble.unsent === true && bubble.sendId === action.sendId)),
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
      const key = action.assistantId;
      if (key !== undefined) {
        const existing = state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === key);
        if (existing !== undefined) {
          const withTarget = {
            ...state,
            currentAssistantId: existing.id,
            currentAssistantKey: key,
            toolTargetAssistantId: undefined,
          };
          const withBubble = attachRunToolCards(withTarget, false);
          return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
        }
        // ツールだけの host があれば、そのカードをこの本文 item にする (確定履歴と同じ形)
        const opened = adoptToolHost(closeCurrentAssistant(state), key) ?? openAssistantForKey(state, action.at, key);
        const withBubble = attachRunToolCards(opened, false);
        return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
      }
      // 旧サーバーの delta は従来どおり開いている応答へ積む
      const withBubble = attachRunToolCards(ensureAssistant(state, action.at), false);
      return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
    }

    case "assistantEnd": {
      const key = action.assistantId;
      const target =
        key !== undefined
          ? state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === key)
          : state.currentAssistantId === null
            ? undefined
            : state.bubbles.find((bubble) => bubble.id === state.currentAssistantId);
      if (target === undefined) {
        if (key !== undefined) return state;
        return state.toolTargetAssistantId === undefined
          ? state
          : { ...state, currentAssistantId: null, currentAssistantKey: undefined, toolTargetAssistantId: undefined };
      }
      const closesCurrent =
        state.currentAssistantId === target.id || (key !== undefined && state.currentAssistantKey === key);
      // 本文の応答が確定した時点で、同じターンの本文なし応答のカードをこの応答へ寄せる (投影と同じ所有者)
      return withCarriedToolCards({
        ...state,
        currentAssistantId: closesCurrent ? null : state.currentAssistantId,
        currentAssistantKey: closesCurrent ? undefined : state.currentAssistantKey,
        toolTargetAssistantId: closesCurrent ? target.id : state.toolTargetAssistantId,
        bubbles: state.bubbles.map((bubble) => (bubble.id === target.id ? { ...bubble, settled: true } : bubble)),
        closedAssistantTexts:
          key !== undefined || target.text === ""
            ? state.closedAssistantTexts
            : [...new Set([...state.closedAssistantTexts, target.text])],
      });
    }

    case "toolStart": {
      const call: ToolCall = {
        id: action.id,
        ...(action.assistantId === undefined ? {} : { assistantId: action.assistantId }),
        name: action.name || "",
        args: action.args || "",
        isError: false,
        done: false,
        output: "",
        ...(action.startedAt !== undefined ? { startedAt: action.startedAt } : {}),
        ...(action.skill ? { skill: action.skill } : {}),
        ...(action.questions ? { questions: action.questions } : {}),
      };
      // カードの置き場所: 同じ応答のバブル → assistant_end で閉じたばかりの応答 → 今ターンの host。
      // 本文を持たない応答 (本文 item にならない) のツールは、確定履歴が同ターンの次の表示可能な
      // 本文 item へ繰り上げるのと同じ持ち主になるまで 1 枚の host に溜める
      const keyTarget =
        action.assistantId === undefined
          ? undefined
          : state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === action.assistantId);
      const ended = closedToolTarget(state, action.assistantId);
      let base = state;
      let targetId = keyTarget?.id ?? ended;
      // 回答待ちの ask_user は**未採用の** host へ入れない: 完了したカードだけを持つ空の host は実行中だけ
      // 描画しないため、質問カードを抱えると回答手段ごと見えなくなる。本文 item を引き取った host は
      // 表示できる所有者なので、同じ応答のカードとしてその item に付ける (確定履歴の投影と同じ境界)
      if (targetId !== undefined && isPendingAskUser(call)) {
        const target = state.bubbles.find((bubble) => bubble.id === targetId);
        if (target !== undefined && isToolHostBubble(target) && target.text === "") targetId = undefined;
      }
      // 旧サーバー (応答IDなし) は本文の補完先そのものへ足す
      if (targetId === undefined && action.assistantId === undefined) {
        base = openAssistantForKey(state, action.at, undefined);
        targetId = base.currentAssistantId ?? undefined;
      }
      // 保留中の run 側カードを先に補ってから新しいカードを足す (逆順だと初回のカードで
      // 新規が先頭になり、run 側の挿入順と逆のツール履歴になる)
      const withBubble = attachRunToolCards(base, false);
      const withRun = {
        ...withBubble,
        // 診断用に、今観測したツールを控える (payload 経由の復元カードと区別する)
        liveToolIds: withBubble.liveToolIds.includes(action.id)
          ? withBubble.liveToolIds
          : [...withBubble.liveToolIds, action.id],
        runTools: { ...withBubble.runTools, [action.id]: call },
      };
      if (targetId !== undefined) {
        const placed = attachCardTo(withRun, toolCardOf(call), targetId);
        // 本文を持たない応答 (item がまだ無い) の usage / metrics は表示する行が無いので捨てる
        return action.assistantId === undefined || keyTarget !== undefined
          ? placed
          : { ...placed, pendingUsage: undefined, pendingMetrics: undefined };
      }
      // 本文を持たない応答なので本文の補完先にはしない。次の表示可能な本文 item まで host に溜める
      if (action.assistantId === undefined) return withRun;
      if (isPendingAskUser(call)) {
        // 回答待ちの ask_user は本文も結果も無く履歴 item にならない。応答IDと応答メタを持つカードを
        // 合成して回答できる状態を保つ (状態行とカードの契約は docs/ask-user.md)
        const opened = openAssistantForKey(withRun, action.at, action.assistantId);
        const bubbleId = opened.currentAssistantId;
        const placed = bubbleId === null ? opened : attachCardTo(opened, toolCardOf(call), bubbleId);
        return {
          ...placed,
          // 本文の補完先にはしない (回答後の本文は新しい応答のカードで開く)
          currentAssistantId: withRun.currentAssistantId,
          currentAssistantKey: withRun.currentAssistantKey,
          toolTargetAssistantId: bubbleId ?? placed.toolTargetAssistantId,
        };
      }
      const host = ensureToolHost(closeCurrentAssistant(withRun), action.at);
      return attachCardTo(host.state, toolCardOf(call), host.id);
    }

    case "toolEnd": {
      // run 側を更新してから補完する (ページ取得がツール完了前に走っていても done / failed に揃う)
      const call = state.runTools[action.id];
      const withRun =
        call === undefined
          ? state
          : {
              ...state,
              liveToolIds: state.liveToolIds.includes(action.id)
                ? state.liveToolIds
                : [...state.liveToolIds, action.id],
              runTools: {
                ...state.runTools,
                [action.id]: {
                  ...call,
                  done: true,
                  isError: action.isError,
                  output: action.output,
                  ...(action.endedAt !== undefined ? { endedAt: action.endedAt } : {}),
                  ...(action.answers ? { answers: action.answers } : {}),
                },
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
                  ? {
                      ...card,
                      phase: action.isError ? "failed" : "done",
                      output: action.output,
                      ...(action.endedAt !== undefined ? { endedAt: action.endedAt } : {}),
                      ...(action.answers ? { answers: action.answers } : {}),
                    }
                  : card,
              ),
            }));
      return clearQuestionActivity(attachRunToolCards(withCard, false));
    }

    case "toolProgress": {
      // ライブ専用の進捗。カードが無ければ作らない (resync が持ち込んだ復元カードへ後から足さない)
      const call = state.runTools[action.id];
      if (call === undefined) return state;
      return { ...state, runTools: { ...state.runTools, [action.id]: { ...call, progress: action.text } } };
    }

    case "usage": {
      // ツールループは 1 バブルに統合されるため、後続メッセージの値で上書きされる (仕様)。
      const next = action.context ? { ...state, context: action.context } : state;
      const keyTarget =
        action.assistantId === undefined
          ? undefined
          : state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === action.assistantId);
      if (keyTarget !== undefined) {
        return updateBubble(next, keyTarget.id, (b) => ({
          ...b,
          usage: action.usage ?? b.usage,
          metrics: action.metrics ?? b.metrics,
        }));
      }
      if (action.assistantId !== undefined) {
        return {
          ...next,
          pendingUsage: action.usage ?? state.pendingUsage,
          pendingMetrics: action.metrics ?? state.pendingMetrics,
        };
      }
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
        // 区切りの位置は次の resync の履歴ページが正。取り込み済みの履歴がある間は
        // beforeMessageIndex (payload.messages の index) では位置が合わないため触らない
        dividers: state.history.supported || holdsFetchedHistory(state) ? state.dividers : legacyMarkers(compactions),
        activity: `会話を圧縮しました（${action.count}回目）`,
        // 圧縮の通知は状態ではなく 1 回きりのお知らせなので、活動ラベルの演出は外す
        activityState: undefined,
      };
    }

    case "status":
      // state は演出の条件 (thinking のときだけ活動ラベルに光を流す)、text は表示文言
      return { ...state, activity: action.text || "処理中…", activityState: action.state || undefined };

    case "queued": {
      // 自分の送信の待機を SSE が先に配る経路 (応答より前) でも送信IDで対応付ける
      const bubbles =
        action.sendId === undefined
          ? state.bubbles
          : state.bubbles.map((bubble) =>
              bubble.sendId === action.sendId && bubble.entryId === undefined
                ? {
                    ...bubble,
                    accepted: true,
                    queued: true,
                    queuedState: "queued" as const,
                    queuePosition: action.position,
                  }
                : bubble,
            );
      // 送信IDがまだ結び付いていないエコーには、この送信の待機位置として控えて応答時に引き継ぐ
      const bound = action.sendId !== undefined && bubbles.some((bubble) => bubble.sendId === action.sendId);
      const queuedSnapshots =
        action.sendId === undefined
          ? state.queuedSnapshots
          : bound
            ? withoutQueuedSnapshots(state.queuedSnapshots, [action.sendId])
            : { ...state.queuedSnapshots, [action.sendId]: { position: action.position } };
      return {
        ...state,
        bubbles,
        queuedSnapshots,
        stateSeq: state.stateSeq + 1,
        // 圧縮中は体感の状態を compacting のまま保つ (実際に走っているのは圧縮)
        runStatus: state.runStatus === "compacting" ? "compacting" : "running",
        queueDepth: action.queueDepth,
        // 件数はコンポーザー直上のブロックが正。状態行は活動の語だけを出す
        activity: state.runStatus === "compacting" ? "圧縮中…" : "実行中…",
        activityState: undefined,
      };
    }

    case "queueCleared": {
      // 破棄された待機メッセージは実行されない。送信IDが分かる分を未送信へ切り替え、
      // 「送信済み」の見た目のまま残さない。応答 (echoSendId) がまだ届いていないエコーは送信IDが
      // 無いため特定できず、控えを残して対応付いた時点で切り替える
      const cleared = new Set(action.sendIds ?? []);
      const bubbles = state.bubbles.map((bubble) => {
        // 送信IDを持たない旧サーバーのバブルは run id で突き合わせる
        const key = bubble.sendId ?? bubble.runId;
        const markUnsent = key !== undefined && cleared.has(key) && bubble.unsent !== true;
        // キューそのものが空になったので、送信IDが分からない分 (旧サーバー) の待機也表示を戻す
        if (!markUnsent && bubble.queued !== true) return bubble;
        return markUnsent
          ? { ...bubble, unsent: true, accepted: false, confirmed: false, ...CLEARED_TURN_END, ...QUEUE_CLEARED }
          : { ...bubble, ...QUEUE_CLEARED };
      });
      const pendingEchoIds = state.pendingEchoIds.filter((id) => {
        const bubble = bubbles.find((item) => item.id === id);
        return bubble?.unsent !== true;
      });
      return {
        ...state,
        bubbles,
        pendingEchoIds,
        stateSeq: state.stateSeq + 1,
        queuedSnapshots: withoutQueuedSnapshots(state.queuedSnapshots, action.sendIds ?? []),
        // 取りこぼしを防ぐため直近の分だけ持ち、対応が取れたら消す
        clearedSendIds: [...state.clearedSendIds, ...cleared].slice(-20),
        queueDepth: 0,
        activity: "待機キューを取り消しました",
        activityState: undefined,
        // 破棄で待機が消えたので、開始直後の演出も残さない
        startingRunId: undefined,
      };
    }

    case "queueCanceled": {
      // 取り消した送信を未送信へ戻す。resync が成功応答より先に届く経路があるため、既に未送信なら
      // 何もしない (状態行の文言は足さず、バブルが変わることを結果の提示にする)
      const target = state.bubbles.find((bubble) => bubble.sendId === action.sendId);
      if (!target || target.unsent === true) return state;
      return {
        ...state,
        bubbles: state.bubbles.map((bubble) =>
          bubble.sendId === action.sendId
            ? { ...bubble, unsent: true, accepted: false, confirmed: false, ...CLEARED_TURN_END, ...QUEUE_CLEARED }
            : bubble,
        ),
        stateSeq: state.stateSeq + 1,
        queuedSnapshots: withoutQueuedSnapshots(state.queuedSnapshots, [action.sendId]),
        // 未送信は pendingEchoIds に残さない (残すと取り消し後の再送で同じ id が二重に載る)
        pendingEchoIds: state.pendingEchoIds.filter((id) => id !== target.id),
      };
    }

    case "startFlashEnd":
      // リングの広がりが終わった合図。演出を持たないときに落としても何も変わらない
      return state.startingRunId === undefined ? state : { ...state, startingRunId: undefined };

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
      const initialSendId = action.runId === undefined ? undefined : state.runInitialSendIds[action.runId];
      const pendingEchoIds =
        action.runId === undefined
          ? state.pendingEchoIds
          : state.pendingEchoIds.filter((id) => {
              const bubble = state.bubbles.find((item) => item.id === id);
              if (bubble === undefined) return true;
              return initialSendId !== undefined ? bubble.sendId !== initialSendId : bubble.runId !== action.runId;
            });
      // 失敗の分類コードは status === "error" のときだけ保持する (停止と例外が同時でもカードを出さない)
      const runError = runErrorFrom(status, action.errorCode, action.error);
      const runStatus: RunStatus = queueDepth > 0 ? "queued" : status === "completed" ? "idle" : status;
      // カードを出すときだけ状態行のエラー文言を空にし、同じ 1 文を二重に出さない。
      // キュー待ちを挟んだ run は queued なのでカードを出さず、現行の文言を維持する
      const cardShown = retryableRunError(runStatus, runError) !== undefined;
      let activity: string;
      if (status === "stopped") activity = "停止しました";
      else if (status === "error") activity = cardShown ? "" : `エラー: ${action.error || "実行に失敗しました"}`;
      // 件数はコンポーザー直上のブロックが正なので、活動の語だけで示す
      else activity = "完了";
      // 確定した応答のバブルは resync でも残す (履歴ページが届くまでの表示を維持する)
      const settledCurrent =
        state.currentAssistantId === null
          ? state
          : updateBubble(state, state.currentAssistantId, (bubble) => ({ ...bubble, settled: true }));
      // 本文 item が現れないまま run が終わったターンは、host を確定履歴の item 境界へ揃えて確定する
      // (本文を持たない応答ごとに 1 item。投影と同じ形にして、resync / F5 でヘッダーが動かないようにする)
      const settled = settleToolHosts(settledCurrent);
      // run_end の所要時間と結末は、その run の user パブルへ写す (entryId の有無を問わず runId 一致)。
      // 未送信のターンは導出側が行を落とす。終端以外の status では値を付けない
      const outcome = runOutcomeOf(status);
      const normalized = normalizeInitialSend(settled.bubbles, initialSendId);
      const withTurnEnd =
        action.runId === undefined || outcome === undefined || action.durationMs === undefined
          ? { ...settled, bubbles: normalized }
          : {
              ...settled,
              bubbles: attachTurnEnd(normalized, action.runId, initialSendId, outcome, action.durationMs),
            };
      const bubbles =
        action.runId === undefined || outcome === undefined || action.durationMs === undefined
          ? withTurnEnd.bubbles
          : attachAssistantTurnEnd(
              withTurnEnd.bubbles,
              action.runId,
              initialSendId,
              outcome,
              action.durationMs,
              state.currentAssistantId,
            );
      // assistant_end を取りこぼしても、run が終われば本文の応答は確定している (投影と同じ所有者へ寄せる)
      const carriedBubbles = carryToolCardsToAnswers(bubbles, state.currentAssistantId).bubbles;
      return {
        ...withTurnEnd,
        bubbles: carriedBubbles,
        pendingEchoIds,
        stateSeq: state.stateSeq + 1,
        currentAssistantId: null,
        currentAssistantKey: undefined,
        currentRunId: undefined,
        closedAssistantTexts: [],
        toolTargetAssistantId: undefined,
        // ターンが終われば host は確定済みの item になる (次の resync で印を戻さない)
        liveHostAssistantIds: [],
        liveHostRunId: undefined,
        toolBubbleIds: {},
        activity,
        activityState: undefined,
        // 開始直後の演出は run の終了でも必ず落とす
        startingRunId: undefined,
        // run が終わったことを取り直しの合図として数える (描画を挟まず reducer で進める)
        runEndSeq: withTurnEnd.runEndSeq + 1,
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
        // 実行を開始した送信は、停止の控えから外す (遅れて届いた 202 で未送信へ戻さない)
        clearedSendIds:
          initialSendId === undefined
            ? withTurnEnd.clearedSendIds
            : withTurnEnd.clearedSendIds.filter((id) => id !== initialSendId),
        // 終わった実行の対応は残さない (同じ run id は再利用しない)
        runInitialSendIds: (() => {
          if (action.runId === undefined) return withTurnEnd.runInitialSendIds;
          const next = { ...withTurnEnd.runInitialSendIds };
          delete next[action.runId];
          return next;
        })(),
      };
    }

    case "setRun":
      // 要求後に終端や次の run が入っていれば、遅れて届いた停止応答で状態 (実行状態・待機件数・
      // 活動文言) を戻さない。描画を挟まない同じバッチでも順序が決まるよう reducer で判定する
      if (action.stateSeq !== undefined && action.stateSeq !== state.stateSeq) return state;
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

    case "clearNotice":
      // 保持の解除は利用者の操作の **開始** だけ。応答 (setRun / queueCanceled など) で消すと、
      // 先に始めた要求の後着応答が、その後に出た別の操作の結果を消す
      return state.notice === undefined ? state : { ...state, notice: undefined };

    case "notice":
      // 押した結果は活動文言と別に持つ。後続の status / resync が activity を戻しても、この 1 行は
      // 次の操作かセッション切替まで残る (取り消しの成否が読めないまま消えるのを避ける)
      return { ...state, notice: action.text };

    case "setActivity":
      // 実行とは別の知らせ (設定変更 / 接続エラーなど) を活動行へ出す。演出の対象外
      return { ...state, activity: action.text, activityState: undefined };
  }
}
