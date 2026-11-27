// chatReducer の状態とアクションの型。群ごとの module が共有するため、hooks 側を import しない。
import type { Bubble, ChatHistoryState, CompactionMarker } from "./chatTypes";
import type { RunErrorInfo } from "./runRetry";
import type {
  AskUserAnswer,
  AskUserQuestion,
  AssistantMeta,
  CompactionInfo,
  ContextUsage,
  HistoryPage,
  MessageMetrics,
  RunErrorCode,
  RunRetryState,
  RunStatus,
  SessionHandoffState,
  SessionNetworkAccess,
  SessionPayload,
  SessionTitleSummary,
  SkillLoad,
  ThinkingLevel,
  ToolCall,
  Usage,
} from "../types";

export type ChatState = {
  bubbles: Bubble[];
  nextId: number;
  currentAssistantId: number | null;
  toolBubbleIds: Record<string, number>;
  /**
   * 直近 run のツールカード (toolCallId -> ToolCall)。履歴ページに未投影のカードを補う元データで、
   * runEnd でも消さない (終了後に遅れて適用されるページへ補うため)。
   */
  runTools: Record<string, ToolCall>;
  /**
   * 表示 item にならない assistant 応答の meta (assistantId 引き)。`assistant_end` が対象バブルを
   * 見つけられなかった応答と、本文なし ask_user の空バブル合成だけが読む。
   */
  assistantMeta: Record<string, AssistantMeta>;
  /** 表示中のセッション。切替 (resync の sessionId 変化) で履歴ページを捨てる */
  sessionId: string;
  /** ヘッダ / お知らせに出す現在のタイトル。一覧の取得を待たず payload の値を正にする */
  title: string;
  /** タイトルの由来と AI 要約の試行 (payload を受ける前は undefined) */
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
   * run が終わった回数。表示には使わず、右パネル (作業フォルダ) の取り直しの合図だけに使う
   * (同じバッチの run_start / run_end では running を観測できないため)。
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
   * 活動表示の由来 (SSE `status` の state)。文言で判定すると BFF の文面変更で演出が消えるため、
   * サーバーが配る state を持ち、thinking のときだけ活動ラベルに光を流す。
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
  /**
   * この会話の egress の実効状態 (payload の networkAccess)。拒否済みカードを許可へ変えられるかの
   * 判定に使い、payload を受ける前は undefined (救済の導線を出さない)。
   */
  networkAccess?: SessionNetworkAccess;
  supportsThinking: boolean;
  availableThinkingLevels: ThinkingLevel[];
  context?: ContextUsage;
  compactions: CompactionInfo[];
  pendingUsage?: Usage;
  pendingMetrics?: MessageMetrics;
  /** 進行中の自動再試行。resync / run_retry で復元し、run_end で消える */
  retry?: RunRetryState;
  /**
   * 最後に失敗したランの分類コードと文言。`runStatus === "error"` のときだけ持ち、失敗の文言は
   * `run.error` (BFF が合成した 1 文) をそのまま使う (停止と例外が同時なら stopped)。
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
   * assistant_end で閉じた直後の応答カード。その応答が要求したツールは次の本文より先に届くため、
   * 次の delta が来るまではこのカードへ足す (新しいカードを空のまま作らない)
   */
  toolTargetAssistantId?: number;
  /**
   * 本文 item を引き取った host の応答ID。履歴の再構築で entryId 付きになると印が写らないため、
   * run の終端まで host として戻す (1 run に複数の host が並び得る。docs/frontend.md)。
   */
  liveHostAssistantIds: string[];
  /** 実行中の thinking 末尾 (live 専用)。SSE の `status.thinking` だけが入れる */
  thinkingText?: string;
  /**
   * `liveHostAssistantIds` を採用した run の id。切断中に run が変わると `run_start` のリプレイが
   * 無いため、run が違えば戻さない (どちらか不明なら判定できないので保持する)。
   */
  liveHostRunId?: string;
  /**
   * run_start で観測した run id -> 展開済みの本文。送信応答が run_start より遅れて届いたとき、
   * エコーを注記込み / `/skill:` 展開済みへ差し替える (直近数件だけ持ち、対応が取れたら消す)。
   */
  runPrompts: Record<string, string>;
  /**
   * run id -> その実行を開始した送信ID (run_start の initialSendId)。所要時間と結末は開始送信の
   * バブルにだけ写し、同じ実行へ注入された追加入力へ複製しない
   */
  runInitialSendIds: Record<string, string>;
  /**
   * 待機列の先頭が実行に移った直後の run id。リングの演出だけに使い、終端は DOM 側 (`startFlashEnd`)
   * が受ける (run_end / queue_cleared / resync でも落とす)。
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
  /** 履歴 API の 404 (未知ルート / セッション消滅)。payload.messages ベースの表示へ戻す */
  | { type: "historyUnsupported"; payload?: SessionPayload }
  | { type: "runStart"; runId?: string; initialSendId?: string; prompt: string; at: number; startedAt: number }
  | { type: "localUser"; text: string; at: number }
  /**
   * 送信応答。未対応付けの最古のエコーへ送信IDを結び付け、実行へ割り当て済みなら run id も写す
   * (queuePosition は要求時の stateSeq が現在と一致するときだけ適用する)。
   */
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
  | { type: "assistantEnd"; assistantId: string; model: string | null }
  | {
      type: "toolStart";
      id: string;
      name: string;
      args: string;
      /** このツールを要求した assistant 応答のID */
      assistantId?: string;
      skill?: SkillLoad;
      questions?: AskUserQuestion[];
      /** BFF 計測の開始時刻 (`run.toolCalls[].startedAt` と同じ値) */
      startedAt: number;
      at: number;
    }
  | {
      type: "toolEnd";
      id: string;
      isError: boolean;
      output: string;
      /** BFF 計測の終了時刻。開始を観測しなかったツールは載らない */
      endedAt?: number;
      answers?: AskUserAnswer[];
    }
  /** investigate の子の進捗。ライブの ToolCall.progress だけを更新する */
  | { type: "toolProgress"; id: string; text: string }
  | { type: "usage"; usage?: Usage; metrics?: MessageMetrics; context?: ContextUsage; assistantId?: string }
  | { type: "compaction"; compaction: CompactionInfo; count: number }
  /**
   * 状態行の活動。`thinking` は live 専用の thinking 末尾 (SSE `status.thinking`)。
   * キーが無い status は tail のクリアを意味する
   */
  | { type: "status"; state: string; text: string; thinking?: string }
  /**
   * 切断 (error / 無音 / 明示再接続) を検知した時点で tail だけを消す。次の thinking delta で戻す
   */
  | { type: "thinkingCleared" }
  | { type: "queued"; sendId: string; position: number; queueDepth: number }
  /** 停止で待機キューを破棄した。sendIds は破棄された送信で、未送信の表示へ切り替える */
  | { type: "queueCleared"; sendIds: string[] }
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
      /** BFF 計測のラン全体の所要時間 */
      durationMs: number;
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
  thinkingText: undefined,
  notice: undefined,
  sessionModel: undefined,
  sessionThinkingLevel: undefined,
  sessionAgentId: undefined,
  sessionAgentName: undefined,
  // payload を受ける前は undefined。承認の救済は出さない
  networkAccess: undefined,
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
  toolTargetAssistantId: undefined,
  liveHostAssistantIds: [],
  liveHostRunId: undefined,
};
