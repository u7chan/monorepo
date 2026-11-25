/** 会話の中身の DTO (ツール呼び出し / run / usage / 履歴の項目)。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import { AskUserAnswerSchema, AskUserQuestionSchema, RunOutcomeSchema, RunStatusSchema } from "./common";

/**
 * スキル読み込み 1 件 (`read` で basename が SKILL.md の呼び出し)。履歴の `ChatMessage.skillLoads` と
 * ライブの `ToolCall.skill` で同じ形を使う。name は frontmatter の name ではなく解決後の親ディレクトリ名。
 */
export const SkillLoadSchema = z.object({
  /** toolCallId */
  id: z.string(),
  name: z.string(),
  /** 解決後の絶対パス (ライブ / 履歴で同じ値にする) */
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  /** 結果がエラーだったときだけ true。キー省略 = ロード扱い (ライブは結果が無いので持たない) */
  isError: z.boolean().optional(),
});
export type SkillLoad = z.infer<typeof SkillLoadSchema>;
export const ToolCallSchema = z.object({
  id: z.string(),
  /** このツールを要求した assistant 応答のID (旧データは載らない) */
  assistantId: z.string().optional(),
  name: z.string(),
  args: z.string(),
  isError: z.boolean(),
  done: z.boolean(),
  output: z.string(),
  /** ライブでスキル読み込みだったときだけ載る (履歴側は ChatMessage.skillLoads) */
  skill: SkillLoadSchema.optional(),
  /**
   * investigate の進捗 (現在の活動 + 子の本文末尾)。SSE の `tool_progress` だけが作るライブ専用で、
   * payload (`run.toolCalls`) と履歴 (`messages[].tools`) には載らない (`docs/api-session-turns.md`)。
   */
  progress: z.string().optional(),
  /**
   * ask_user の質問。skill と違い、ライブ (`tool_start` / `payload.run.toolCalls`) と履歴
   * (`messages[].tools`) の両方で同じ ToolCall に載る (`docs/api-sessions.md`)。
   */
  questions: z.array(AskUserQuestionSchema).optional(),
  /**
   * ask_user の回答。ツール結果の `details` から導出する。停止・中止では空配列になり、
   * カードは「回答なしで終了」として復元できる (実行中は未回答なので undefined)。
   */
  answers: z.array(AskUserAnswerSchema).optional(),
  /**
   * ツール実行の開始 / 終了 (BFF 計測のサーバー時計, epoch ms)。SDK は実行時刻を持たないため、
   * イベントの到着時刻で測った値だけを載せる (`docs/api-sessions.md`)。両方揃ったカードだけが
   * 実行時間を出せる (停止・中止で `tool_execution_end` が来なかったカードは `endedAt` が無い)。
   */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
/** ツール実行 1 件の開始 / 終了 (BFF 計測)。run を跨いでセッションに控え、履歴の投影へ写す */
export type ToolTiming = { startedAt: number; endedAt: number };
/** ラン失敗の公開分類。上流の原文は公開せず、このコードだけを SSE / payload に載せる */
export const RunErrorCodeSchema = z.enum([
  "auth_required",
  "oauth_expired",
  "insufficient_quota",
  "model_unavailable",
  "context_overflow",
  "rate_limit",
  "unknown",
]);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;
/**
 * 進行中の自動再試行。`waiting` は SDK の backoff 中 (retryAt まで)、`retrying` は次の
 * assistant の message_start を観測した後。`attempt` は現在の連続失敗系列の番号で、
 * ラン全体の回数は RunPayload.totalRetryCount が持つ。
 */
export const RunRetryStateSchema = z.object({
  phase: z.enum(["waiting", "retrying"]),
  attempt: z.number(),
  maxAttempts: z.number(),
  /** waiting の待機終了予定 (epoch ms)。サーバー基準で、クライアントは serverNow との差で残りを出す */
  retryAt: z.number().optional(),
  reason: RunErrorCodeSchema,
});
export type RunRetryState = z.infer<typeof RunRetryStateSchema>;
export const RunPayloadSchema = z.object({
  id: z.string(),
  /** この実行を開始した送信のID。所要時間と結末はこの送信だけが持つ */
  initialSendId: z.string().optional(),
  status: RunStatusSchema,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  /** 最終失敗の分類コード。`status === "error"` のときだけ載る (停止と例外が同時なら載せない) */
  errorCode: RunErrorCodeSchema.optional(),
  prompt: z.string(),
  toolCalls: z.array(ToolCallSchema),
  /** 進行中の自動再試行。成功・最終失敗・手動停止で消える (累計は totalRetryCount に残る) */
  retry: RunRetryStateSchema.optional(),
  /** ラン中の auto_retry_start 通知の累計 (再試行のスケジュール回数。待機中の中止も含む) */
  totalRetryCount: z.number(),
});
export type RunPayload = z.infer<typeof RunPayloadSchema>;
/** pi SDK の AssistantMessage.usage。cost は SDK が算出済みで、プロバイダが請求額を報告する場合はそれを優先し、無ければ料金表から計算する (料金表が無いモデルは 0)。 */
export const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** cacheWrite のうち 1h 保持分 (Anthropic のみ報告する) */
  cacheWrite1h: z.number().optional(),
  /** output に含まれる推論トークン。報告しないプロバイダではキーを省略する */
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
export type Usage = z.infer<typeof UsageSchema>;
/**
 * 応答時間のメタ。BFF がイベントの到着時刻で測った実測か、SDK が履歴へ記録した所要時間からの概算。
 * 由来は `source` で表し、未指定は実測として扱う (足し忘れた経路を概算扱いにしないため)。
 */
export const MessageMetricsSchema = z.object({
  durationMs: z.number(),
  /** 最初の delta までの時間。delta が無かった (非ストリーミング) メッセージでは省略する */
  ttftMs: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  /** 由来。省略時は measured。recorded は SDK 記録値からの導出で、表示側が ≈ を付ける */
  source: z.enum(["measured", "recorded"]).optional(),
});
export type MessageMetrics = z.infer<typeof MessageMetricsSchema>;
/**
 * 本文を持たない assistant 応答の時刻 / usage / 応答時間。履歴 item にならない未回答の ask_user を
 * クライアントが復元するとき、元の応答の値を `assistantId` で引き当てるために payload へ載せる。
 * 値の無い項目はキーごと省き、再起動後・旧 payload では配列自体を載せない。
 */
export const AssistantMetaSchema = z.object({
  assistantId: z.string(),
  /** SDK が持つメッセージの作成時刻 (epoch ms)。時刻を持たない履歴ではキーを省略する */
  at: z.number().optional(),
  /**
   * 応答を生成したモデル (`provider/model`)。null はモデル情報なし。欠けた値を現在のセッションモデルで
   * 補わない (別のモデルで生成した応答に誤って付く)
   */
  model: z.string().nullable().optional(),
  usage: UsageSchema.optional(),
  /** 応答時間 (メッセージ生成の時間で、回答待ちの時間は含まない)。由来は source を見る */
  metrics: MessageMetricsSchema.optional(),
});
export type AssistantMeta = z.infer<typeof AssistantMetaSchema>;
/** SDK の getContextUsage。compaction 直後は tokens / percent が null になる。 */
export const ContextUsageSchema = z.object({
  tokens: z.number().nullable(),
  contextWindow: z.number(),
  percent: z.number().nullable(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
/** pi SDK の compaction_end が返す理由。entry には保存されないため DTO 側で合成する。 */
export const CompactionReasonSchema = z.enum(["manual", "threshold", "overflow"]);
export type CompactionReason = z.infer<typeof CompactionReasonSchema>;
/**
 * pi SDK の CompactionEntry をそのまま写せる形 (表示用の文字列へ潰さず、独自の連番 ID も振らない)。
 * reason と estimatedTokensAfter は entry に保存されないため、compaction_end を受けた時点の値を
 * 合成する。beforeMessageIndex は最新の 1 件だけが持つ (SDK は最新の compaction しか context に
 * 残さないため、以前の圧縮位置は messages から復元できない)。
 */
export const CompactionInfoSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  /** ISO 8601 (SDK の SessionEntryBase と同じ形式) */
  timestamp: z.string(),
  summary: z.string(),
  firstKeptEntryId: z.string(),
  tokensBefore: z.number(),
  /** 要約生成に使った LLM 呼び出しの使用量 (将来使う値として落とさない) */
  usage: UsageSchema.optional(),
  fromHook: z.boolean().optional(),
  /** 区切りを置く messages の index (この index の手前)。最新の compaction だけが持つ */
  beforeMessageIndex: z.number().optional(),
  reason: CompactionReasonSchema.optional(),
  /** compaction_end の推定値。UI には出さないが永続化を見据えて保持する */
  estimatedTokensAfter: z.number().optional(),
  /**
   * BFF 計測の圧縮時間 (`compaction_start` から `compaction_end` の到着まで)。entry には保存されない
   * ため、受信時に `compactionMeta` へ控えた値を写す。失敗・中止では載らない
   */
  durationMs: z.number().optional(),
});
export type CompactionInfo = z.infer<typeof CompactionInfoSchema>;
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  stopReason: z.string().optional(),
  /**
   * assistant を生成したモデル (`provider/model`)。null はモデル情報なし (旧履歴 / 未報告)。
   * user は持たない
   */
  model: z.string().nullable().optional(),
  /** assistant 応答の実行内 ID。live の delta / ツールと履歴を本文一致に依らず対応付ける */
  assistantId: z.string().optional(),
  /** user メッセージを送信した送信ID。payload でもエコーを本文一致に依らず対応付ける */
  sendId: z.string().optional(),
  /** user メッセージを注入した run の id */
  runId: z.string().optional(),
  /** SDK が持つメッセージの作成時刻 (epoch ms)。時刻を持たない履歴ではキーを省略する */
  at: z.number().optional(),
  /** プロバイダが報告した使用量。数値なのでマスク不要。未報告ならキーを省略する (0 と区別する) */
  usage: UsageSchema.optional(),
  metrics: MessageMetricsSchema.optional(),
  tools: z.array(ToolCallSchema).optional(),
  /** このバブルに出す分 (本文を持たない read だけのターンからの繰り上げ分を含む)。無ければキーを省略 */
  skillLoads: z.array(SkillLoadSchema).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
/**
 * 履歴項目のコンテキスト状態。active = 現在の SDK context に生のまま残る、summarized = 最新の
 * compaction の要約へ置き換わった、excluded = context_edit などで context から外れた。
 * summarized と excluded はどちらも生のコンテキストに無いが、要約と混同しないため別の値にする。
 */
export const HistoryContextStateSchema = z.enum(["active", "summarized", "excluded"]);
export type HistoryContextState = z.infer<typeof HistoryContextStateSchema>;
/**
 * ターンの結末。値の定義は `run_end` と同じで、キュー待ちと回答待ち (ask_user の実行区間) を含めず、
 * status を終端の 3 値へ絞ったもの。メタ行の `Done · 1m 20s` はこの値から作る
 */
export const TurnEndSchema = z.object({
  outcome: RunOutcomeSchema,
  durationMs: z.number(),
});
export type TurnEnd = z.infer<typeof TurnEndSchema>;
/** 表示用の履歴 1 件。id は SDK entry の id で、ページのカーソルと重複排除に使う */
export const HistoryMessageItemSchema = ChatMessageSchema.extend({
  kind: z.literal("message"),
  id: z.string(),
  context: HistoryContextStateSchema,
  /**
   * user メッセージを送信した送信ID。クライアントが自分の送信エコー (POST 応答の sendId) と
   * entry を本文一致に依らず対応付ける。送信IDの記録が無い保存済みの履歴では載らない
   */
  sendId: z.string().optional(),
  /**
   * user メッセージを注入した run の id。同じ実行へ複数の送信が属するため、送信の識別には使わない。
   * 対応を失った保存済みの履歴では載らない
   */
  runId: z.string().optional(),
  /**
   * この user メッセージを送信した run の所要時間 / 結末 (`run_end` と同じ定義で、キュー待ちを含まない)。
   * run の記憶はメモリのみなので、再起動とアイドル sweep の後は載らない (結末のセグメントを出さない)
   */
  runDurationMs: z.number().optional(),
  runOutcome: RunOutcomeSchema.optional(),
  /**
   * この item が属するターンの結末。ターン最後の本文あり応答 item だけが持つ (user item が履歴
   * ページの窓の外へ落ちても結末を出せるようにする)。値の控えは user item と同じくメモリのみ
   */
  turnEnd: TurnEndSchema.optional(),
});
export type HistoryMessageItem = z.infer<typeof HistoryMessageItemSchema>;
/** 圧縮イベントそのもの。発生位置を entry の並びで持ち、区切りをここに置く */
export const HistoryCompactionItemSchema = z.object({
  kind: z.literal("compaction"),
  id: z.string(),
  compaction: CompactionInfoSchema,
});
export type HistoryCompactionItem = z.infer<typeof HistoryCompactionItemSchema>;
export const HistoryItemSchema = z.discriminatedUnion("kind", [HistoryMessageItemSchema, HistoryCompactionItemSchema]);
export type HistoryItem = z.infer<typeof HistoryItemSchema>;
/**
 * 202 で受理したが user entry としてまだ保存されていない送信。サーバー再起動でキューごと消えた分は
 * `unsent` として見せ、実行中 / キュー待ちの分は pending エコーのまま扱わせる (表示から消さない)。
 * `text` は表示用にマスク済み (再送は本文を送り直さず `runId` でサーバーへ依頼する)。`position` は
 * `queued` の順位で、`unsentSends` の並び (受理順) を順位として数えさせないために載せる。
 */
export const PendingSendSchema = z.object({
  /** 受付ごとの送信ID。取消・再送・破棄・バブルとの対応はこの値で行う */
  sendId: z.string(),
  /** 実行へ割り当て済みなら実行ID (手動圧縮中など未割当の送信では省略する) */
  runId: z.string().optional(),
  text: z.string(),
  at: z.number(),
  /**
   * queued = BFF 待機中または SDK 実キューに残る (取消の対象)。steering = SDK が取り出して注入待ち
   * (取消・再送・破棄は不可)。running = 開始送信の準備中か注入済みで保存待ち。unsent = 配送対象から
   * 外れた未保存の送信 (再送・破棄の対象)
   */
  state: z.enum(["unsent", "queued", "steering", "running"]),
  /**
   * 待機中の順位 (1 始まり)。`state` が queued / steering のときだけ載り、BFF と SDK の未注入分を
   * 合わせた並びの index + 1 (SSE `queued` の `position` と同じ意味)。キューに無い送信は載らない
   */
  position: z.number().optional(),
});
export type PendingSend = z.infer<typeof PendingSendSchema>;
/**
 * カーソル型の履歴ページ。items は古い→新しい、nextCursor はさらに古いページを取るための
 * 先頭 item の id。prevCursor は先頭 item の直前の item id (ページ間の連続性検証用)。
 * messageCount / summarizedMessageCount はページではなく現行ブランチ全体の値で、
 * クライアントが保持済みページの dim (summarized) 判定を更新するのに使う。
 */
export const HistoryPageSchema = z.object({
  sessionId: z.string(),
  items: z.array(HistoryItemSchema),
  nextCursor: z.string().nullable(),
  /** このページの先頭 item の直前にある item の id (無ければ null)。保持分と繋がるかの判定に使う */
  prevCursor: z.string().nullable(),
  hasMore: z.boolean(),
  /** 現在有効なコンテキストの先頭 message item。summarized が 0 件のときは null */
  activeContextStartId: z.string().nullable(),
  messageCount: z.number(),
  summarizedMessageCount: z.number(),
});
export type HistoryPage = z.infer<typeof HistoryPageSchema>;
/**
 * SSE の `resync` を配った理由。`attempt_discarded` は失敗試行の取り消し (SDK の context_edit) で、
 * 未確定のストリーミング応答を表示から捨てる唯一の理由。省略は同じ実行の継続を表す
 */
export const ResyncReasonSchema = z.enum(["attempt_discarded"]);
export type ResyncReason = z.infer<typeof ResyncReasonSchema>;
/** bash の外向き HTTPS を会話ごとにどう扱うか。`ask` だけが承認カードを出す */
export const NetworkAccessModeSchema = z.enum(["allow", "ask", "deny"]);
export type NetworkAccessMode = z.infer<typeof NetworkAccessModeSchema>;
/**
 * この会話の egress の実効状態。`approved` は BFF のメモリだけにあり、停止・会話削除・sweep で戻る。
 * 拒否済みカードの「許可に変更」を出す条件と、押した後の表示に使う。
 */
export const SessionNetworkAccessSchema = z.object({
  mode: NetworkAccessModeSchema,
  approved: z.boolean(),
});
export type SessionNetworkAccess = z.infer<typeof SessionNetworkAccessSchema>;
