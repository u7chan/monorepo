/** 会話の DTO (payload / summary / SSE / 診断 / 操作の結果と要求 body)。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import { AgentPayloadInfoSchema } from "./catalog";
import {
  AskUserAnswerSchema,
  AskUserQuestionSchema,
  ModelRefSchema,
  RunStatusSchema,
  SessionTitleSummarySchema,
  ThinkingLevelSchema,
} from "./common";
import {
  AssistantMetaSchema,
  ChatMessageSchema,
  CompactionInfoSchema,
  ContextUsageSchema,
  MessageMetricsSchema,
  NetworkAccessModeSchema,
  PendingSendSchema,
  ResyncReasonSchema,
  RunErrorCodeSchema,
  RunPayloadSchema,
  RunRetryStateSchema,
  SessionNetworkAccessSchema,
  SkillLoadSchema,
  UsageSchema,
} from "./messages";
import { ServeCommandSchema } from "./runtime";

/**
 * 会話の引き継ぎの状態。`consumed` は引き継ぎ後に最初に受理した送信で立ち、
 * チップ (HANDOFF.md を参照) の表示条件になる。旧サーバーは載せない (省略 = 引き継ぎなし)。
 */
export const SessionHandoffStateSchema = z.object({
  operationId: z.string(),
  at: z.number(),
  /** HANDOFF.md を作った引き継ぎか */
  memo: z.boolean(),
  /** 引き継ぎ後の最初の送信を受理済みか (未送信の破棄では戻らない) */
  consumed: z.boolean(),
  /** 確定後の履歴削除 (片付け) が残っているか。true の間は会話を開けない */
  cleanupPending: z.boolean(),
});
export type SessionHandoffState = z.infer<typeof SessionHandoffStateSchema>;
export const SessionPayloadSchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  piSessionId: z.string(),
  /** rootCwd 相対の作業ディレクトリ (未所属は所属スペースのスクラッチ。"" = root は永続化なしの既定スペースだけ) */
  cwd: z.string(),
  /** SSE の世代。seq は再起動で 0 に戻るため、カーソルの整合判定に使う */
  eventGeneration: z.string(),
  /**
   * 会話履歴の世代。履歴クリアでだけ変わり、SSE の世代 (eventGeneration) とは独立に再起動後も残る。
   * 変わったら同じ会話のまま旧カーソル・旧バブルを捨てて履歴を取り直す。旧サーバーは省略する
   */
  historyGeneration: z.string().optional(),
  projectId: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  supportsThinking: z.boolean().optional(),
  /** 実効モデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  availableThinkingLevels: z.array(ThinkingLevelSchema).optional(),
  status: RunStatusSchema,
  title: z.string(),
  /** 会話タイトルの由来と AI 要約の試行。旧サーバーは載せない */
  titleSummary: SessionTitleSummarySchema.optional(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  /** この payload を組み立てた時刻 (epoch ms)。retry.retryAt との差でクライアントが残り時間を出す */
  serverNow: z.number(),
  queueDepth: z.number(),
  /** 受理済みでまだ保存されていない送信 (古い→新しい)。旧サーバーは載せないため省略可 (省略 = 未対応) */
  pendingSends: z.array(PendingSendSchema).optional(),
  /** 手動圧縮の開始時刻 (epoch ms)。status === "compacting" のときだけ載る */
  compactionStartedAt: z.number().optional(),
  /** この会話の完了を Discord へ送るか。サーバーは常に載せ、読む側は省略を false として扱う */
  notify: z.boolean().optional(),
  /** サイドバーに固定するか */
  pinned: z.boolean(),
  lastSeq: z.number(),
  /** `resync` イベントだけが載せる理由 (省略 = 同じ実行の継続) */
  resyncReason: ResyncReasonSchema.optional(),
  agent: AgentPayloadInfoSchema.optional(),
  run: RunPayloadSchema.nullable(),
  messages: z.array(ChatMessageSchema),
  /**
   * 表示 item にならない assistant 応答のメタ情報 (未回答の ask_user を合成するときに使う)。
   * 同じ BFF が SDK 履歴から引ける間だけ載り、旧サーバーはキー自体を省略する
   */
  assistantMeta: z.array(AssistantMetaSchema).optional(),
  /** 会話の圧縮履歴 (古い→新しい)。区切りは messages に混ぜず、回数はこの長さから導出する */
  compactions: z.array(CompactionInfoSchema),
  /** セッションのコンテキスト使用量。SDK が持たない (スタブ等) ときはキーを省略する */
  context: ContextUsageSchema.optional(),
  /** 直前の引き継ぎの状態。引き継ぎを受けていない会話と旧サーバーは省略する */
  handoff: SessionHandoffStateSchema.optional(),
  /** この会話の egress の実効状態。旧サーバーはキーを省略する (省略 = 承認の状態を出さない) */
  networkAccess: SessionNetworkAccessSchema.optional(),
  /** 分岐元の会話 id。分岐した会話だけが載せ、親のタイトルは一覧から引く (旧サーバーは省略する) */
  parentSessionId: z.string().optional(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;
export const SessionSummarySchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  title: z.string(),
  /** 会話タイトルの由来と AI 要約の試行。旧サーバーは載せない */
  titleSummary: SessionTitleSummarySchema.optional(),
  agentId: z.string(),
  agentName: z.string().optional(),
  status: RunStatusSchema,
  /**
   * ask_user の未 settle の待機があるか。待機を持たない未ロードの会話と旧サーバーは省略し、
   * `running` の意味 (BFF がそのランのために動いている) は変えない
   */
  awaitingAnswer: z.boolean().optional(),
  queueDepth: z.number(),
  /** この会話の完了を Discord へ送るか。サーバーは常に載せ、読む側は省略を false として扱う */
  notify: z.boolean().optional(),
  /** サイドバーに固定するか。未指定の旧データは false として扱う */
  pinned: z.boolean(),
  /** 同じ会話のままエージェント / スペースを引き継げるか。旧サーバーは載せないため省略可 (省略 = false) */
  canHandoff: z.boolean().optional(),
  /** プロジェクト所属か。真では引き継ぎ先のスペースを選ばない (同じ作業ディレクトリで移す先がない) */
  projectSession: z.boolean().optional(),
  /** 確定後の履歴削除 (片付け) が残っているか。残っている間は開けない / 新しい引き継ぎを受けない */
  handoffCleanup: z.boolean().optional(),
  /** 履歴クリアの確定後に残った削除 (片付け) が未完了か。残っている間は開けず、履歴クリアも 409 */
  historyCleanup: z.boolean().optional(),
  /** 生ログ (`session.jsonl`) をダウンロードできるか。旧サーバーは載せないため省略可 (省略 = false) */
  hasRawLog: z.boolean().optional(),
  messageCount: z.number(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  /**
   * その会話の作業ディレクトリ (workdir) の serve 成功実績。実績が無ければ null。
   * cwd を共有するプロジェクト会話は同じ値を返す (実行状況からの起動可否と起動の確認に使う)。
   */
  serveCommand: ServeCommandSchema.nullable(),
  model: z.string().optional(),
  projectId: z.string().optional(),
  /**
   * 実行状況 (全スペース横断) の経過時間と終了表示のための時刻。未ロードの会話は実行を持たないため
   * 載せない (idle として返し、`lastUsedAt` を開始時刻の代用にしない)。
   */
  runStartedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** 直近のランの所要時間 (runOutcomes にあるときだけ)。無ければ終了時刻だけを出す */
  lastRunDurationMs: z.number().optional(),
  compactionStartedAt: z.number().optional(),
  /** 未 settle の質問のうち最も古い開始時刻。回答待ちの経過時間の起点 */
  awaitingSince: z.number().optional(),
  /** 分岐元の会話 id。分岐した会話だけが載せ、分岐先は同じスペースの一覧から引く */
  parentSessionId: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const PostMessageResultSchema = z.object({
  queued: z.boolean(),
  queueDepth: z.number(),
  /** 受付ごとの送信ID。再送でも同じ値を返す */
  sendId: z.string(),
  /** 実行へ割り当て済みなら実行ID (待機しただけの送信では省略する) */
  runId: z.string().optional(),
});
export type PostMessageResult = z.infer<typeof PostMessageResultSchema>;
export const StopResultSchema = z.object({
  ok: z.literal(true),
  status: RunStatusSchema,
});
export type StopResult = z.infer<typeof StopResultSchema>;
/** `DELETE /api/sessions/:id/unsent/:runId` の応答 */
export const DiscardUnsentResultSchema = z.object({ ok: z.literal(true) });
export type DiscardUnsentResult = z.infer<typeof DiscardUnsentResultSchema>;
/** `DELETE /api/sessions/:id/queue/:runId` の応答。件数は resync の payload が正なので載せない */
export const CancelQueuedResultSchema = z.object({ ok: z.literal(true) });
export type CancelQueuedResult = z.infer<typeof CancelQueuedResultSchema>;
/** `POST /api/sessions/:id/compact` の応答。完了まで待って実効状態を返す */
export const SessionCompactionResultSchema = z.object({
  sessionId: z.string(),
  status: RunStatusSchema,
});
export type SessionCompactionResult = z.infer<typeof SessionCompactionResultSchema>;
/**
 * `PATCH /api/sessions/:id/notify` の応答。live / 未ロードで同じ形にし、SDK セッションを開かない
 * 未ロードでも返せるよう会話全文 (`messages`) は載せない。
 */
export const SessionNotifyResponseSchema = z.object({
  sessionId: z.string(),
  notify: z.boolean(),
});
export type SessionNotifyResponse = z.infer<typeof SessionNotifyResponseSchema>;
/** `PATCH /api/sessions/:id/pin` の応答。live / 未ロードで同じ小さな DTO を返す。 */
export const SessionPinnedResponseSchema = z.object({
  sessionId: z.string(),
  pinned: z.boolean(),
});
export type SessionPinnedResponse = z.infer<typeof SessionPinnedResponseSchema>;
/**
 * `PATCH /api/sessions/:id/title` の応答。notify と同じく live / 未ロードで同じ形にし、
 * SDK セッションを開かない未ロードでも返せるよう会話全文 (`messages`) は載せない。
 * `title` は正規化 (trim / 秘密のマスク / 上限) 後で、一覧の表示と一致する。
 */
export const SessionTitleResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type SessionTitleResponse = z.infer<typeof SessionTitleResponseSchema>;
/**
 * `POST /api/sessions/:id/move` の応答。移動後も会話全文は返さず、一覧の更新に必要な最小だけを返す。
 * `spaceId` は移動先で、`title` は一覧と同じ正規化 (未設定は「無題のセッション」) 後の値。
 * `memo` は HANDOFF.md を書いた引き継ぎか、`cleanupPending` は履歴削除の片付けが残っているか。
 */
export const SessionMoveResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  spaceId: z.string(),
  memo: z.boolean().optional(),
  cleanupPending: z.boolean().optional(),
});
export type SessionMoveResponse = z.infer<typeof SessionMoveResponseSchema>;
/**
 * `POST /api/sessions/:id/history/clear` の応答。会話の行・URL・作業フォルダ・添付は変えず、履歴だけを
 * 空にする。`title` は一覧と同じ正規化 (自動 / AI タイトルは空へ戻るため「無題のセッション」) 後の値。
 * `changed: false` は現世代で消すものが無かった場合で、クライアントは自動再試行しない。
 * `cleanupPending` は確定後の削除が残っているか (残っている間は開けない)。
 */
export const SessionHistoryClearResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  historyGeneration: z.string(),
  changed: z.boolean(),
  cleanupPending: z.boolean().optional(),
});
export type SessionHistoryClearResponse = z.infer<typeof SessionHistoryClearResponseSchema>;

// ---------------------------------------------------------------------------
// リクエスト body スキーマ
// route が見るのは JSON の形と型だけ。必須判定と正規化 (trim / 上限 / 未知キー) は catalog が正
// ---------------------------------------------------------------------------
export const PostMessageBodySchema = z.object({
  /** 通常の送信は必須。`resendSendId` を指定した再送では本文を送らず、サーバーが保存済みの本文を使う */
  text: z.string().optional(),
  /**
   * タイトル用の入力。定型プロンプト (suggestion) を結合する前の本文で、省略時は `text` を使う
   * (従来形式のクライアントはタイトル用の情報を送らない)。
   */
  titleSource: z.string().optional(),
  /** 添付 (root 相対。既定スペースは `<appdir>/uploads/<sessionId>/` 配下)。件数とパスの検証は attachments.ts が正 */
  attachments: z.array(z.string()).optional(),
  /** 未送信メッセージの再送。本文は保存済みの生テキストを使い、同じ送信IDで実行し直す */
  resendSendId: z.string().optional(),
  /** `resendSendId` の互換名。同時指定は 400 */
  resendRunId: z.string().optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;
/**
 * ask_user の回答。質問数と index の対応、`skipped` の排他は store が正 (route は JSON の形だけを見る)。
 * 全質問に 1 つずつ回答が要り、一部だけの回答は 400 になる。
 */
export const AnswerQuestionBodySchema = z.object({ answers: z.array(AskUserAnswerSchema) });
export type AnswerQuestionBody = z.infer<typeof AnswerQuestionBodySchema>;
/** 拒否済みの承認カードから許可へ変える要求。接続先はカードに出たホストをそのまま渡す */
export const ApproveNetworkAccessBodySchema = z.object({ host: z.string().min(1).max(253) });
export type ApproveNetworkAccessBody = z.infer<typeof ApproveNetworkAccessBodySchema>;
export const ApproveNetworkAccessResponseSchema = z.object({
  ok: z.literal(true),
  host: z.string(),
  mode: NetworkAccessModeSchema,
  approved: z.literal(true),
});
export type ApproveNetworkAccessResponse = z.infer<typeof ApproveNetworkAccessResponseSchema>;
export const CreateSessionBodySchema = z.object({
  spaceId: z.string().optional(),
  agentId: z.string().optional(),
  // 未指定ならエージェント定義 → アプリ既定の順に解決する (null は 400)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  // 未指定は未所属 (cwd = root になるのは永続化なしの既定スペースだけ)。未知の id は 400
  projectId: z.string().min(1).optional(),
  // 新規チャットで選んだ通知トグルを、作成されるセッションへ引き継ぐ (未指定は false)
  notify: z.boolean().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
/** チャット設定変更。省略は現在値維持、null・空 body は 400 */
export const UpdateSessionSettingsBodySchema = z.object({
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type UpdateSessionSettingsBody = z.infer<typeof UpdateSessionSettingsBodySchema>;
/**
 * 会話ごとの通知トグル。model / thinkingLevel の設定変更とは別経路にして、
 * SDK の設定変更と busy 判定を通さずに実行中でも切り替えられるようにする。
 */
export const UpdateSessionNotifyBodySchema = z.object({ notify: z.boolean() });
export type UpdateSessionNotifyBody = z.infer<typeof UpdateSessionNotifyBodySchema>;
/** 会話ごとのサイドバー固定。SDK に触れず busy 中も更新できる。 */
export const UpdateSessionPinnedBodySchema = z.object({ pinned: z.boolean() });
export type UpdateSessionPinnedBody = z.infer<typeof UpdateSessionPinnedBodySchema>;
/**
 * 会話タイトルの変更。notify と同じく SDK に触らないため実行中でも変えられる。
 * 空・空白だけ・上限超えの正規化は store が正 (route は JSON の形だけを見る)。
 */
export const UpdateSessionTitleBodySchema = z.object({ title: z.string() });
export type UpdateSessionTitleBody = z.infer<typeof UpdateSessionTitleBodySchema>;
/**
 * セッションの引き継ぎ (引っ越しの拡張)。要求元スペースは query (`sessionSpaceGuard` が照合する) で、
 * 本文は移動先・引き継ぎ先のエージェント・メモの有無を持つ。`agentId` の省略は現在のエージェントを維持し、
 * `memo` の省略は false (既存の「引っ越す」の意味を変えない)。
 */
export const MoveSessionBodySchema = z.object({
  spaceId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  memo: z.boolean().optional(),
});
export type MoveSessionBody = z.infer<typeof MoveSessionBodySchema>;
/**
 * 会話履歴のクリア。`historyGeneration` は確認時点の履歴世代 (payload の値、旧データは空文字) で、
 * 変わっていれば別タブのクリアなどで履歴が入れ替わっているため 409 にする。
 */
export const ClearSessionHistoryBodySchema = z.object({ historyGeneration: z.string() });
export type ClearSessionHistoryBody = z.infer<typeof ClearSessionHistoryBodySchema>;
/**
 * 会話の分岐。`agentId` の省略は親のスナップショット (エージェント・スキル・ツールの許可) を維持し、
 * 指定時は引き継ぎと同じく現在の定義から作り直す。対象の会話とスペースは path / query で決まる。
 */
export const ForkSessionBodySchema = z.object({
  agentId: z.string().min(1).optional(),
});
export type ForkSessionBody = z.infer<typeof ForkSessionBodySchema>;
export const EventDataSchemas = {
  // `startedAt` は payload の `run.startedAt` と同じ値。クライアントは受信時刻ではなくこれを使う
  // (切断中に始まった run の `run_start` がリプレイされても開始時刻がぶれない)
  run_start: z.object({
    runId: z.string(),
    /** この実行を開始した送信のID (旧サーバーは載せない) */
    initialSendId: z.string().optional(),
    prompt: z.string(),
    startedAt: z.number(),
  }),
  text: z.object({ delta: z.string(), assistantId: z.string().optional() }),
  tool_start: z.object({
    id: z.string(),
    name: z.string(),
    args: z.string(),
    skill: SkillLoadSchema.optional(),
    questions: z.array(AskUserQuestionSchema).optional(),
    /** BFF がイベントの到着時刻で測った開始時刻。`run.toolCalls[].startedAt` と同じ値 */
    startedAt: z.number().optional(),
    /** このツールを要求した assistant 応答のID */
    assistantId: z.string().optional(),
  }),
  tool_end: z.object({
    id: z.string(),
    name: z.string().optional(),
    isError: z.boolean(),
    output: z.string(),
    answers: z.array(AskUserAnswerSchema).optional(),
    /** BFF がイベントの到着時刻で測った終了時刻。`run.toolCalls[].endedAt` と同じ値 */
    endedAt: z.number().optional(),
  }),
  // investigate の子の進捗。`id` は tool_start / tool_end と同じ toolCallId で、ライブの
  // `ToolCall.progress` だけを更新する (payload の `run.toolCalls` には載せない)
  tool_progress: z.object({ id: z.string(), text: z.string() }),
  // 状態行の活動ラベル。`thinking` は live 専用の thinking 末尾で、保存せずリプレイでも落とす。
  // mask 済み・最大 `LIVE_THINKING_MAX_CHARS` code point (`server/src/live-thinking.ts`)
  status: z.object({ state: z.string(), text: z.string(), thinking: z.string().optional() }),
  queued: z.object({
    position: z.number(),
    queueDepth: z.number(),
    /** 待機した送信のID。応答が届く前でも、この値で自分の待機を特定できる */
    sendId: z.string().optional(),
    prompt: z.string(),
  }),
  // 停止で破棄した待機メッセージの送信ID。クライアントが「未送信」へ切り替えるために使う
  queue_cleared: z.object({ sendIds: z.array(z.string()).optional() }).strict(),
  // assistant の message_end ごとに 1 件。usage はプロバイダが報告したときだけ入る
  usage: z.object({
    usage: UsageSchema.optional(),
    metrics: MessageMetricsSchema.optional(),
    context: ContextUsageSchema.optional(),
    assistantId: z.string().optional(),
  }),
  /**
   * assistant の応答が終わった (message_end)。クライアントは開いている応答カードを閉じ、
   * 続く delta を次のカードへ入れる。usage とは別で、model だけを載せる
   */
  assistant_end: z.object({
    assistantId: z.string().optional(),
    /** 応答を生成したモデル (`provider/model`)。null は不明、未指定は旧サーバー */
    model: z.string().nullable().optional(),
  }),
  run_end: z.object({
    runId: z.string().optional(),
    status: RunStatusSchema,
    queueDepth: z.number(),
    /**
     * BFF 計測のラン全体の所要時間。クライアントが完了時の合計時間として表示する。
     * キュー待ちは含めない (開始は `startRun()` の時刻)。旧サーバーは載せない
     */
    durationMs: z.number().optional(),
    error: z.string().optional(),
    /** 最終失敗の分類コード。payload の `run.errorCode` と同じ値で、error と組で載る */
    errorCode: RunErrorCodeSchema.optional(),
    messageCount: z.number().optional(),
    /** ラン中の再試行スケジュール累計 (error の文言にも含まれる。構造で読むクライアント用) */
    totalRetryCount: z.number().optional(),
    // message_end 時点の context は SDK が履歴へ入れる前で古いため、確定値は run_end で配る
    context: ContextUsageSchema.optional(),
  }),
  // 自動再試行の開始 / 再実行開始 / 解除。payload.run.retry と同じ形を serverNow と組で配る
  run_retry: z.object({
    retry: RunRetryStateSchema.nullable(),
    totalRetryCount: z.number(),
    serverNow: z.number(),
  }),
  // compaction_end の 1 件分と、その時点の累計回数。続けて resync が同じ状態を配る
  compaction: z.object({
    compaction: CompactionInfoSchema,
    count: z.number(),
  }),
  resync: SessionPayloadSchema,
  session_deleted: z.object({ sessionId: z.string() }),
} as const;
export type SSEEventType = keyof typeof EventDataSchemas;
export type SSEEventData = {
  [T in SSEEventType]: z.infer<(typeof EventDataSchemas)[T]>;
};
type EventEntryFor<T extends SSEEventType> = {
  seq: number;
  type: T;
  data: SSEEventData[T];
  at: number;
};
export type EventEntry = {
  [T in SSEEventType]: EventEntryFor<T>;
}[SSEEventType];

// ---------------------------------------------------------------------------
// セッション診断 (GET /api/sessions/:id/diagnostics。docs/diagnostics.md)
// ---------------------------------------------------------------------------
/** diagnostics の items が持つ種別。SSE の型と 1:1 で、イベントを足すとこの enum も型で要求される */
const SSEEventTypeSchema = z.enum(Object.keys(EventDataSchemas) as [SSEEventType, ...SSEEventType[]]);
/**
 * 1 件のイベント。`data` は mask 済みの値をそのまま載せ、上限を超えた分だけ切り詰める (そのときは
 * `truncated` を立て、元の schema を満たさない可能性がある)。
 */
export const DiagnosticsEventSchema = z.object({
  seq: z.number(),
  type: SSEEventTypeSchema,
  /** サーバーが発行した時刻 (epoch ms) */
  at: z.number(),
  /** `data` の JSON バイト数 (切り詰め前) */
  bytes: z.number(),
  data: z.unknown(),
  /** `data` を上限へ切り詰めた */
  truncated: z.literal(true).optional(),
});
export type DiagnosticsEvent = z.infer<typeof DiagnosticsEventSchema>;
/**
 * `GET /api/sessions/:id/diagnostics` の応答。不具合の切り分け用に、サーバー側の観測を 1 回ぶんまとめる。
 * 本文 (メッセージ / 質問 / 回答) は載せず、件数と mask 済みの要約だけを持つ。上限で落とした件数は
 * `events.dropped` に残し、無言で切り詰めない。会話タイトルも本文の先頭を含み得るため載せない。
 */
export const SessionDiagnosticsSchema = z.object({
  kind: z.literal("u7agent-session-diagnostics"),
  version: z.literal(1),
  sessionId: z.string(),
  /** 採取時刻 (epoch ms) */
  capturedAt: z.number(),
  /** SSE の世代。client 側の lastCursor.generation と突き合わせる */
  eventGeneration: z.string(),
  /** この時点で最後に発行した seq */
  lastSeq: z.number(),
  status: RunStatusSchema,
  meta: z.object({
    spaceId: z.string(),
    agentId: z.string(),
    agentName: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    /** 作業ディレクトリ (workspace root 相対) */
    workdir: z.string(),
    createdAt: z.number(),
    lastUsedAt: z.number(),
    messageCount: z.number(),
    model: z.string().optional(),
    /** 実効 thinkingLevel。SDK が補正した値なので、定義上の列挙より広い文字列で返す (payload と同じ) */
    thinkingLevel: z.string().optional(),
    notify: z.boolean(),
    pinned: z.boolean(),
    /** 直近の保存失敗 (meta / JSONL 共通)。成功していれば省略 */
    persistError: z.string().optional(),
    /** 直近の送信対応記録の保存失敗 */
    sendsError: z.string().optional(),
    /** 送信対応記録がディスクと食い違ったまま (書込みの再試行待ち) */
    sendsDirty: z.boolean(),
  }),
  /** 待機中の送信。本文は載せず、件数と run id だけを持つ */
  queue: z.object({ depth: z.number(), sendIds: z.array(z.string()) }),
  run: z
    .object({
      id: z.string(),
      status: RunStatusSchema,
      startedAt: z.number(),
      endedAt: z.number().optional(),
      /** ラン中の自動再試行のスケジュール累計 */
      totalRetryCount: z.number(),
      retry: RunRetryStateSchema.optional(),
      errorCode: RunErrorCodeSchema.optional(),
      error: z.string().optional(),
    })
    .nullable(),
  /** ask_user の待機 / 回答済み (toolCallId と件数だけ。質問文と回答本文は載せない) */
  questions: z.array(z.object({ toolCallId: z.string(), questionCount: z.number(), settled: z.boolean() })),
  /**
   * タイトルの由来と AI 要約の試行 (状態・モデル・usage)。依頼本文と生成タイトルは載せない
   * (診断 JSON が本文を含まない契約の一部)。旧サーバーは載せないため省略可。
   */
  title: SessionTitleSummarySchema.optional(),
  events: z.object({
    /** 件数の上限 (これより古い分は返さない) */
    limit: z.number(),
    /** 応答全体のバイト上限 */
    maxBytes: z.number(),
    /** リングバッファに残っている件数 */
    available: z.number(),
    /** 古い→新しい順のイベント */
    items: z.array(DiagnosticsEventSchema),
    /** 件数とバイトの上限で落とした件数 */
    dropped: z.number(),
    /** `data` を切り詰めたイベントの件数 */
    truncated: z.number(),
  }),
  /** 生ログ (`session.jsonl`) の有無。無いときは UI がダウンロードを押せないようにする */
  raw: z.object({ available: z.boolean(), bytes: z.number().optional() }),
});
export type SessionDiagnostics = z.infer<typeof SessionDiagnosticsSchema>;
