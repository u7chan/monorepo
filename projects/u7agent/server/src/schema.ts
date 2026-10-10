/** API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import { WEB_SEARCH_PROVIDER_IDS } from "./web-search-providers";
import type { SandboxLandlockStatus, SandboxRuntimeCommand, SandboxRuntimeEnvironment } from "./sandbox/protocol";
import type { SecretKind } from "./secret-crypto";

export const SpaceSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.number() });
export type Space = z.infer<typeof SpaceSchema>;
export const CreateSpaceBodySchema = z.object({ name: z.string().trim().min(1).max(80) });

export const RunStatusSchema = z.enum(["idle", "running", "queued", "compacting", "completed", "stopped", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * ランが終端したときの結末。`RunStatusSchema` の部分集合で、ターン終端の表示 (`Complete` /
 * `Stopped` / `Failed`) に使う。終端以外 (`idle` / `running` / `queued` / `compacting`) は載せない
 */
export const RunOutcomeSchema = z.enum(["completed", "stopped", "error"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const SkillDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** system prompt へ常時入る本文。エージェントの「役割 / 基本指示」(systemPrompt) とは別の語にする */
  body: z.string(),
});
export type SkillDef = z.infer<typeof SkillDefSchema>;

/** pi SDK の thinkingLevel。UI では「Effort」と表示する。 */
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** 認証済みモデルの provider/id 参照 (SDK の Model そのものではない) */
export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** 空の会話の firstview に出す定型プロンプト。label がボタン文言、prompt が送信文字列。 */
export const AgentSuggestionSchema = z.object({
  label: z.string(),
  prompt: z.string(),
});
export type AgentSuggestion = z.infer<typeof AgentSuggestionSchema>;

export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  skillIds: z.array(z.string()),
  /** webp / png の data URL。未指定のときはキー自体を省略する (null は保存・応答に現れない) */
  icon: z.string().optional(),
  // 未指定のときはキー自体を省略する (null は保存・応答に現れない)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  /** 未指定なら firstview のボタンを出さない (アプリ既定のフォールバックは持たない) */
  suggestions: z.array(AgentSuggestionSchema).optional(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

export const CatalogSchema = z.object({
  agents: z.array(AgentDefSchema),
  skills: z.array(SkillDefSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * 全エージェントで常時有効な同梱スキル 1 件。`skillIds` では外せないため、カタログの `skills` とは
 * 別フィールドで返し、エージェント編集のスキル欄がチェック済み・無効の行として出せるようにする。
 */
export const BuiltinSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type BuiltinSkillInfo = z.infer<typeof BuiltinSkillInfoSchema>;

/**
 * GET `/api/agents` の応答。`builtinAgent` はサーバー所有の汎用エージェントで、
 * `agents` (ユーザー定義) には含まれない。サーバーは常にオブジェクトを返し、
 * `null` はクライアントが取得前に持つ初期状態だけを表す。
 */
export const CatalogResponseSchema = CatalogSchema.extend({
  builtinAgent: AgentDefSchema.nullable(),
  builtinSkills: z.array(BuiltinSkillInfoSchema),
});
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

export const AgentSkillInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type AgentSkillInfo = z.infer<typeof AgentSkillInfoSchema>;

export const AgentPayloadInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  skillIds: z.array(z.string()),
  skills: z.array(AgentSkillInfoSchema),
});
export type AgentPayloadInfo = z.infer<typeof AgentPayloadInfoSchema>;

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

/**
 * ask_user の上限。ツールのパラメータ検証 (`server/src/ask-user-tool.ts` が throw) と
 * DTO / リクエスト本体の検証が同じ値を使う。
 */
export const ASK_USER_QUESTIONS_MIN = 1;
export const ASK_USER_QUESTIONS_MAX = 4;
export const ASK_USER_OPTIONS_MAX = 6;
export const ASK_USER_QUESTION_MAX = 500;
export const ASK_USER_HEADER_MAX = 40;
export const ASK_USER_LABEL_MAX = 80;
export const ASK_USER_DESCRIPTION_MAX = 200;
export const ASK_USER_ANSWER_TEXT_MAX = 2000;

/** ask_user の選択肢。選択は入力補助で、自由記入は常に受け付ける (`docs/ask-user.md`) */
export const AskUserOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type AskUserOption = z.infer<typeof AskUserOptionSchema>;

export const AskUserQuestionSchema = z.object({
  question: z.string(),
  /** カードの短い見出し */
  header: z.string().optional(),
  /** 省略時は options の有無で決める (UI は options の有無だけを見る) */
  type: z.enum(["choice", "text"]).optional(),
  options: z.array(AskUserOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
  placeholder: z.string().optional(),
});
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

/**
 * 質問への回答。`index` は questions の添字で、質問文の文字列では引かない (同じ質問文が 2 つあると壊れる)。
 * `skipped` は質問ごとの「回答しない」で、`selected` / `text` とは排他 (両方指定は 400)。
 */
export const AskUserAnswerSchema = z.object({
  index: z.number().int().min(0),
  selected: z.array(z.string().max(ASK_USER_LABEL_MAX)).max(ASK_USER_OPTIONS_MAX).optional(),
  text: z.string().max(ASK_USER_ANSWER_TEXT_MAX).optional(),
  skipped: z.boolean().optional(),
});
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  isError: z.boolean(),
  done: z.boolean(),
  output: z.string(),
  /** ライブでスキル読み込みだったときだけ載る (履歴側は ChatMessage.skillLoads) */
  skill: SkillLoadSchema.optional(),
  /**
   * investigate の進捗 (現在の活動 + 子の本文末尾)。SSE の `tool_progress` だけが作るライブ専用で、
   * payload (`run.toolCalls`) と履歴 (`messages[].tools`) には載らない (`docs/api-sessions.md`)。
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

/** pi SDK の AssistantMessage.usage。cost は pi-ai の calculateCost 済み (料金表が無いモデルは 0)。 */
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

/** BFF がイベントの到着時刻で測る応答時間。SDK は生成開始時刻しか持たない。 */
export const MessageMetricsSchema = z.object({
  durationMs: z.number(),
  /** 最初の delta までの時間。delta が無かった (非ストリーミング) メッセージでは省略する */
  ttftMs: z.number().optional(),
  tokensPerSecond: z.number().optional(),
});
export type MessageMetrics = z.infer<typeof MessageMetricsSchema>;

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

/** 表示用の履歴 1 件。id は SDK entry の id で、ページのカーソルと重複排除に使う */
export const HistoryMessageItemSchema = ChatMessageSchema.extend({
  kind: z.literal("message"),
  id: z.string(),
  context: HistoryContextStateSchema,
  /**
   * user メッセージを送信した run の id。クライアントが自分の送信エコー (POST 応答の runId) と
   * entry を厳密に対応付けるために使う。旧サーバー / 対応を失った履歴では載らない
   */
  runId: z.string().optional(),
  /**
   * この user メッセージを送信した run の所要時間 / 結末 (`run_end` と同じ定義で、キュー待ちを含まない)。
   * run の記憶はメモリのみなので、再起動とアイドル sweep の後は載らない (ターン終端の行を出さない)
   */
  runDurationMs: z.number().optional(),
  runOutcome: RunOutcomeSchema.optional(),
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
  runId: z.string(),
  text: z.string(),
  at: z.number(),
  state: z.enum(["unsent", "queued", "running"]),
  /**
   * 待機中の順位 (1 始まり)。`state === "queued"` のときだけ載り、値は `record.queue` の index + 1
   * (SSE `queued` の `position` と同じ意味)。旧サーバーは載せない
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
 * ワークスペース内のプロジェクト。cwd は rootCwd 相対で、DB へ写せるよう列はこの 4 つに保つ。
 * 後から所属を変える API は無いため、配下セッションの cwd も作成時に固定される。
 */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** rootCwd 相対の正規化パス (root 自身は登録できない) */
  cwd: z.string(),
  createdAt: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

export const SessionPayloadSchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  piSessionId: z.string(),
  /** rootCwd 相対の作業ディレクトリ (未所属は所属スペースのスクラッチ。"" = root は永続化なしの通常スペースだけ) */
  cwd: z.string(),
  /** SSE の世代。seq は再起動で 0 に戻るため、カーソルの整合判定に使う */
  eventGeneration: z.string(),
  projectId: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  supportsThinking: z.boolean().optional(),
  /** 実効モデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  availableThinkingLevels: z.array(ThinkingLevelSchema).optional(),
  status: RunStatusSchema,
  title: z.string(),
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
  agent: AgentPayloadInfoSchema.optional(),
  run: RunPayloadSchema.nullable(),
  messages: z.array(ChatMessageSchema),
  /** 会話の圧縮履歴 (古い→新しい)。区切りは messages に混ぜず、回数はこの長さから導出する */
  compactions: z.array(CompactionInfoSchema),
  /** セッションのコンテキスト使用量。SDK が持たない (スタブ等) ときはキーを省略する */
  context: ContextUsageSchema.optional(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export const SessionSummarySchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  title: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  status: RunStatusSchema,
  queueDepth: z.number(),
  /** この会話の完了を Discord へ送るか。サーバーは常に載せ、読む側は省略を false として扱う */
  notify: z.boolean().optional(),
  /** サイドバーに固定するか。未指定の旧データは false として扱う */
  pinned: z.boolean(),
  /** 別のスペースへ引っ越せるか。旧サーバーは載せないため省略可 (省略 = false) */
  canMove: z.boolean().optional(),
  messageCount: z.number(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  model: z.string().optional(),
  projectId: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * 直近の送信結果 (通常通知とテスト送信で共通の 1 件)。URL とレスポンス原文は入れない。
 * 応答が返らなかった (タイムアウト / ネットワーク / リダイレクト拒否) ときは status を省略する。
 */
export const NotificationResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  latencyMs: z.number(),
  /** Discord の message、またはアプリ側の固定文言 */
  message: z.string().optional(),
  code: z.number().optional(),
  /** 429 の待機秒数 (Discord の retry_after を切り上げた整数)。429 以外では省略する */
  retryAfter: z.number().optional(),
  at: z.number(),
});
export type NotificationResult = z.infer<typeof NotificationResultSchema>;

/** アプリデータの SQLite に保存する通知設定。webhookUrl は API 応答へ出さない (write-only) */
export const NotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  webhookUrl: z.string().optional(),
  baseUrl: z.string().optional(),
  lastResult: NotificationResultSchema.optional(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

/** GET / PUT `/api/notifications` の応答。保存済み URL は `configured` と末尾 4 文字だけを返す */
export const NotificationsResponseSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal("discord"),
  configured: z.boolean(),
  webhookHint: z.string().optional(),
  baseUrl: z.string().optional(),
  lastResult: NotificationResultSchema.optional(),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponseSchema>;

/**
 * GET / PUT / DELETE `/api/settings/archive` の応答。`excludeNames` は常に実効値で、
 * `overridden` が false のときは既定の一覧を使っている（行が無い）。
 */
export const ArchiveSettingsResponseSchema = z.object({
  excludeNames: z.array(z.string()),
  defaultExcludeNames: z.array(z.string()),
  overridden: z.boolean(),
  maxNames: z.number(),
  maxNameLength: z.number(),
});
export type ArchiveSettingsResponse = z.infer<typeof ArchiveSettingsResponseSchema>;

export const ModelOptionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  supportsThinking: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const RuntimeAuthSourceSchema = z.enum([
  "environment",
  "stored",
  "runtime",
  "fallback",
  "models_json_key",
  "models_json_command",
  "unknown",
]);
export type RuntimeAuthSource = z.infer<typeof RuntimeAuthSourceSchema>;

/** 認証の出所だけを表す。ラベルや認証情報の値は API に含めない。 */
export const RuntimeAuthSchema = z.object({
  configured: z.boolean(),
  source: RuntimeAuthSourceSchema.optional(),
  environmentVariables: z.array(z.string()),
});
export type RuntimeAuth = z.infer<typeof RuntimeAuthSchema>;

export const RuntimeVersionsSchema = z.object({
  piCodingAgent: z.string(),
  piAi: z.string().optional(),
  commitHash: z.string().optional(),
});
export type RuntimeVersions = z.infer<typeof RuntimeVersionsSchema>;

export const RuntimeCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
});
export type RuntimeCatalogModel = z.infer<typeof RuntimeCatalogModelSchema>;

export const RuntimeCatalogProviderSchema = z.object({
  provider: z.string(),
  auth: RuntimeAuthSchema,
  models: z.array(RuntimeCatalogModelSchema),
});
export type RuntimeCatalogProvider = z.infer<typeof RuntimeCatalogProviderSchema>;

/**
 * GET /api/runtime/models と カタログ更新 の 503。カタログを取れなかった回に空の一覧で 200 を返さず、
 * 全 provider 未認証と区別できるようにする。
 */
export const RUNTIME_MODELS_UNAVAILABLE_MESSAGE = "ランタイムのモデル情報を取得できません";

/** GET /api/runtime/models。モデル一覧はこの API を開いたときだけ取得する。 */
export const RuntimeModelsResponseSchema = z.object({
  catalogCount: z.number().int().nonnegative(),
  availableCount: z.number().int().nonnegative(),
  versions: RuntimeVersionsSchema,
  providers: z.array(RuntimeCatalogProviderSchema),
});
export type RuntimeModelsResponse = z.infer<typeof RuntimeModelsResponseSchema>;

/**
 * 設定 → モデルのAPIキー入力の境界。短い値は通常出力のマスカーの下限 (MIN_SECRET_LENGTH) と揃え、
 * 長い値は DB / メモリを守るために上限を置く。
 */
export const PROVIDER_API_KEY_MIN_LENGTH = 8;
export const PROVIDER_API_KEY_MAX_LENGTH = 2048;

/** 設定 → モデルの provider メモの上限。秘密情報ではなく、長文でカードが伸びるのを抑える境界 */
export const PROVIDER_MEMO_MAX_LENGTH = 500;

/** 設定 → モデルの 1 プロバイダー行。認証状態は出所だけで、値・ラベル・生の認証エラーは含めない。 */
export const ProviderAuthSettingSchema = z.object({
  provider: z.string(),
  name: z.string(),
  auth: RuntimeAuthSchema,
  /** provider_credentials に行がある (保存済みの希望状態) */
  managed: z.boolean(),
  /** provider_credentials.updatedAt (epoch ms)。null = 行が無い / 移行前の行で不明 */
  keyUpdatedAt: z.number().nullable(),
  /** auth.apiKey.login を持ち、この画面からキーを登録できる */
  canSetApiKey: z.boolean(),
  supportsOAuth: z.boolean(),
  /** 現在のカタログに provider が無い (DB 行にしか無い) */
  orphan: z.boolean(),
  /** このプロセスの SDK 反映が未完了 (apply = 未適用 / remove = 削除未反映) */
  degraded: z.enum(["apply", "remove"]).optional(),
  /**
   * 人間用メモ。provider_memos の行と同じで、null = 未設定。キーの登録有無 (managed) とは独立する。
   * 秘密情報ではないので、マスカーにも載せない (docs/secrets.md)。
   */
  memo: z.string().nullable(),
});
export type ProviderAuthSetting = z.infer<typeof ProviderAuthSettingSchema>;

/** GET /api/settings/models。カタログ全件は載せず、利用可能なモデルは allowedModels だけが持つ */
export const ModelsSettingsResponseSchema = z.object({
  runtimeAvailable: z.boolean(),
  /** `provider/model` の一覧。未設定 (null) = 制限なし。許可されているかの正はこのフィールドだけ */
  allowedModels: z.array(z.string()).nullable(),
  /** 保存値。null は未設定 (既定なし)。実効値は health.model */
  defaultModel: z.string().nullable(),
  /** 設定されていても無視する移行前の環境変数名 */
  ignoredEnvironmentVariables: z.array(z.string()),
  providers: z.array(ProviderAuthSettingSchema),
});
export type ModelsSettingsResponse = z.infer<typeof ModelsSettingsResponseSchema>;

/** 変更系 (PUT / DELETE / resync) の応答。GET と同型 + 必須の state (GET は state を持たない) */
export const ModelMutationResponseSchema = ModelsSettingsResponseSchema.extend({
  state: z.enum(["applied", "applied_unsynced"]),
});
export type ModelMutationResponse = z.infer<typeof ModelMutationResponseSchema>;

/**
 * POST /api/settings/models/catalog/refresh。設定は変えず、取得できなくても 200 で現在のカタログを返す
 * (`catalogError` にだけ今回の取得結果の固定文言を載せる。一覧を失わせない)。
 */
export const ModelCatalogRefreshResponseSchema = RuntimeModelsResponseSchema.extend({
  /** 今回の取得試行の結果。null なら成功 */
  catalogError: z.string().nullable(),
});
export type ModelCatalogRefreshResponse = z.infer<typeof ModelCatalogRefreshResponseSchema>;

/** 変更系の失敗応答 (何も変わっていない)。400 は error のみ */
export const ModelMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type ModelMutationError = z.infer<typeof ModelMutationErrorSchema>;

export const UpdateProviderKeyBodySchema = z.object({
  apiKey: z.string().min(PROVIDER_API_KEY_MIN_LENGTH).max(PROVIDER_API_KEY_MAX_LENGTH),
});
export type UpdateProviderKeyBody = z.infer<typeof UpdateProviderKeyBodySchema>;

/** メモの保存。空文字は行を消して未設定へ戻す (trim は service が行う) */
export const UpdateProviderMemoBodySchema = z.object({
  memo: z.string().max(PROVIDER_MEMO_MAX_LENGTH),
});
export type UpdateProviderMemoBody = z.infer<typeof UpdateProviderMemoBodySchema>;

/** 利用可能なモデルの一括保存。両方 null が「未設定へ戻す」なので DELETE は持たない */
export const UpdateModelAvailabilityBodySchema = z.object({
  allowedModels: z.array(z.string()).nullable(),
  defaultModel: z.string().nullable(),
});
export type UpdateModelAvailabilityBody = z.infer<typeof UpdateModelAvailabilityBodySchema>;

/** 画像生成のカタログ 1 件。provider は将来の追加に備えて載せ、値は開放しない */
export const ImageModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
});
export type ImageModel = z.infer<typeof ImageModelSchema>;

/** カタログの出どころ。live 以外は取得に失敗しており、前回の一覧か SDK 同梱を表示している */
export const ImageCatalogSourceSchema = z.enum(["live", "stored", "sdk"]);
export type ImageCatalogSource = z.infer<typeof ImageCatalogSourceSchema>;

/**
 * 音声カタログ 1 件。`voices` は live が宣言する話者で、宣言が無いとき（Fish Audio / Seed Audio など）は
 * 載せない（UI は自由記述を許し、サーバーも生成前ガードをしない）。
 */
export const SpeechModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  voices: z.array(z.string()).optional(),
});
export type SpeechModel = z.infer<typeof SpeechModelSchema>;

/**
 * 音声カタログの出どころ。live 以外は取得に失敗しており、前回の一覧か同梱の既定 1 件を表示している。
 * 画像の `sdk` と同じ位置付けだが、同梱が SDK ではなく 1 件だけなので別名にする（docs/speech-generation.md）。
 */
export const SpeechCatalogSourceSchema = z.enum(["live", "stored", "default"]);
export type SpeechCatalogSource = z.infer<typeof SpeechCatalogSourceSchema>;

/**
 * GET /api/settings/content の `image`。`configured: false` のとき `model` は null（行が無い = 未設定）。
 * 音声など別の生成物を足すときは、この兄弟として項目を増やす（`image` の形は変えない）。
 */
export const ContentImageSettingsSchema = z.object({
  model: z.string().nullable(),
  /** 選択肢。live カタログ（取得できないときは前回の一覧 / SDK 同梱） */
  models: z.array(ImageModelSchema),
  /** 上の models の出どころ。live 以外は取得に失敗した状態 */
  catalogSource: ImageCatalogSourceSchema,
  /** live を最後に取得できた時刻 (epoch ms)。SDK 同梱を表示しているときは null */
  fetchedAt: z.number().nullable(),
});
export type ContentImageSettings = z.infer<typeof ContentImageSettingsSchema>;

/**
 * GET /api/settings/content の `speech`。行があるときは `model` / `voice` を返し、`NULL` の既存列は
 * 既定モデルと「そのモデルが宣言する先頭ボイス」へフォールバックして返す（UI に「（未設定）」を出さない）。
 * `configured: false` のときは `model` が null で、`voice` は空文字になる。
 */
export const ContentSpeechSettingsSchema = z.object({
  model: z.string().nullable(),
  /** 再開時に送る話者。空文字は「指定なし」（宣言が無いモデル）で、本文から `voice` を落とす */
  voice: z.string(),
  /** 選択肢。live カタログ（取得できないときは前回の一覧 / 同梱の既定 1 件）。話者の宣言を含む */
  models: z.array(SpeechModelSchema),
  /** 上の models の出どころ。live 以外は取得に失敗した状態 */
  catalogSource: SpeechCatalogSourceSchema,
  /** live を最後に取得できた時刻 (epoch ms)。同梱の既定を表示しているときは null */
  fetchedAt: z.number().nullable(),
});
export type ContentSpeechSettings = z.infer<typeof ContentSpeechSettingsSchema>;

/**
 * GET /api/settings/content。`configured: false` のとき provider は null（行が無い = 未設定）。
 * APIキーは返さない。
 */
export const ContentSettingsResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  /** SDK ランタイムの初期化に成功したか。false のときキー登録は 503（model-settings と同じ） */
  runtimeAvailable: z.boolean(),
  image: ContentImageSettingsSchema,
  speech: ContentSpeechSettingsSchema,
});
export type ContentSettingsResponse = z.infer<typeof ContentSettingsResponseSchema>;

/** 変更系（PUT / DELETE）の応答。SDK への反映を持たないため `applied` だけを返す */
export const ContentMutationResponseSchema = ContentSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type ContentMutationResponse = z.infer<typeof ContentMutationResponseSchema>;

/**
 * POST /api/settings/content/image/catalog/refresh。設定は変えず、取得できなくても 200 で現在の一覧を返す
 * （`catalogError` にだけ失敗の固定文言を載せる。一覧を失わせない）。
 */
export const ImageCatalogRefreshResponseSchema = z.object({
  models: z.array(ImageModelSchema),
  catalogSource: ImageCatalogSourceSchema,
  fetchedAt: z.number().nullable(),
  /** 今回の取得結果。null なら成功 */
  catalogError: z.string().nullable(),
});
export type ImageCatalogRefreshResponse = z.infer<typeof ImageCatalogRefreshResponseSchema>;

/**
 * POST /api/settings/content/speech/catalog/refresh。形は画像の再取得と同じで、取得できなくても 200 で
 * 現在の一覧を返し、`catalogError` にだけ失敗の固定文言を載せる（一覧を失わせない）。
 */
export const SpeechCatalogRefreshResponseSchema = z.object({
  models: z.array(SpeechModelSchema),
  catalogSource: SpeechCatalogSourceSchema,
  fetchedAt: z.number().nullable(),
  /** 今回の取得結果。null なら成功 */
  catalogError: z.string().nullable(),
});
export type SpeechCatalogRefreshResponse = z.infer<typeof SpeechCatalogRefreshResponseSchema>;

/** 変更系の失敗応答（何も変わっていない）。400 は error のみ */
export const ContentMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type ContentMutationError = z.infer<typeof ContentMutationErrorSchema>;

/** provider / model の変更。キーは保持したまま差し替える（行が無ければ 400） */
export const UpdateContentImageBodySchema = z.object({
  provider: z.string(),
  model: z.string(),
});
export type UpdateContentImageBody = z.infer<typeof UpdateContentImageBodySchema>;

/**
 * 音声モデル / 話者の変更。キーと provider は保持したまま差し替える（行が無ければ 400）。
 * `voice` の空文字は「指定なし」で、宣言が無いモデルへの自由記述もここを通す（照合はサービス側）。
 */
export const UpdateContentSpeechBodySchema = z.object({
  model: z.string(),
  voice: z.string(),
});
export type UpdateContentSpeechBody = z.infer<typeof UpdateContentSpeechBodySchema>;

/** 画像APIキーの登録・上書き。長さは provider_credentials と同じ */
export const UpdateContentKeyBodySchema = z.object({
  apiKey: z.string().min(PROVIDER_API_KEY_MIN_LENGTH).max(PROVIDER_API_KEY_MAX_LENGTH),
});
export type UpdateContentKeyBody = z.infer<typeof UpdateContentKeyBodySchema>;

/**
 * 設定 → ランタイムの実行環境カードが使う状態。`connected` だけが情報を持ち、他は理由の分類だけを返す
 * (URL / トークン / 内部エラーは載せない)。`connected` は診断 API の正常応答だけで、
 * ツール実行の成功を保証しない。
 */
export const RuntimeEnvironmentStateSchema = z.enum([
  "connected",
  "not_configured",
  "unreachable",
  "unauthorized",
  "timeout",
  "probe_failed",
]);
export type RuntimeEnvironmentState = z.infer<typeof RuntimeEnvironmentStateSchema>;

/**
 * サンドボックスの `GET /v1/runtime/info` の応答検証。ワイヤ契約の正は `sandbox/protocol.ts` の
 * `SandboxRuntimeInfo` で、ここは BFF が受けた応答を検証するための写し。
 */
export const SandboxRuntimeInfoSchema = z.object({
  environment: z.object({
    os: z.string(),
    arch: z.string(),
    user: z.string(),
    isRoot: z.boolean(),
    workspace: z.string(),
  }),
  commands: z.array(z.object({ name: z.string(), version: z.string().nullable() })),
  landlock: z.object({
    state: z.enum(["enabled", "unavailable"]),
    abi: z.number().nullable(),
    minAbi: z.number(),
    reason: z.enum(["wrapper_missing", "unsupported", "abi_unsupported", "probe_failed"]).optional(),
  }),
});

/**
 * GET /api/runtime/environment の公開 DTO。未接続でも HTTP 200 で返し、UI は HTTP ステータスや
 * 文言ではなく `state` で分岐する。共通の項目は `sandbox/protocol.ts` の型をそのまま使う。
 */
export type RuntimeEnvironmentResponse =
  | {
      state: "connected";
      environment: SandboxRuntimeEnvironment;
      commands: SandboxRuntimeCommand[];
      landlock: SandboxLandlockStatus;
    }
  | { state: Exclude<RuntimeEnvironmentState, "connected"> };

/** クライアントへ配るため、ワイヤ契約の共通項目も schema 経由で再 export する */
export type { SandboxLandlockStatus, SandboxRuntimeCommand, SandboxRuntimeEnvironment };

/** client/src/types.ts の Health に加え、ルート固有のフィールドを optional で許容する。 */
export const HealthSchema = z.object({
  cwd: z.string().optional(),
  ready: z.boolean(),
  model: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.enum(["authentication_required", "model_whitelist_empty", "runtime_unavailable"]).optional(),
  ok: z.boolean().optional(),
  availableModels: z.array(z.string()).optional(),
  modelOptions: z.array(ModelOptionSchema).optional(),
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  /** 保存された既定モデルが利用不能なときの理由 (ready は true のまま) */
  defaultModelError: z.string().optional(),
  /** 保存された既定モデルが無い状態。候補があっても新規会話はモデル未指定では作れない */
  defaultModelUnset: z.boolean().optional(),
  tools: z.array(z.string()).optional(),
  availabilityError: z.string().optional(),
  sandboxConfigured: z.boolean().optional(),
  /** プレビュー オリジン (別リスナー) のブラウザから見たポート。待受は別 env で、prod は compose が publish */
  filePreviewPort: z.number().optional(),
  /** サンドボックスで serve した成果物のブラウザから見たポート */
  previewPort: z.number().optional(),
  /** 実行中の SDK バージョン。ランタイムの診断とは独立に出し続ける */
  versions: RuntimeVersionsSchema.optional(),
  /** ダウンロード ZIP の除外規則の実効値。UI は行にダウンロードを出すかの判定に使う */
  archive: z
    .object({
      excludeNames: z.array(z.string()),
    })
    .optional(),
  /** 会話ストアの状態。null は永続化なし (未設定・テスト) */
  sessionStore: z
    .object({
      path: z.string().nullable(),
      ok: z.boolean(),
      error: z.string().optional(),
      /** 保存に失敗している live セッション数 */
      dirty: z.number().optional(),
    })
    .optional(),
  /** アプリデータ (プロジェクト / カタログ) の SQLite。null は永続化なし (未設定・テスト) */
  appDb: z
    .object({
      path: z.string().nullable(),
      ok: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * 作業領域の一覧 (サンドボックス GET /v1/files の応答をそのまま返す)。
 * ワイヤ契約の正は server/src/sandbox/protocol.ts で、ここは BFF が受けた応答の検証用。
 */
export const FileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  /** lstat が symlink のとき true。type は辿った先の実体の種別 */
  symlink: z.boolean().optional(),
  /** stat できたファイルだけ (ディレクトリには付かない) */
  size: z.number().optional(),
  /** epoch ms。stat できたエントリに付き、壊れた symlink には付かない */
  mtime: z.number().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListingSchema = z.object({
  /** root 相対の正規化パス (root は ".") */
  path: z.string(),
  entries: z.array(FileEntrySchema),
  truncated: z.boolean(),
});
export type FileListing = z.infer<typeof FileListingSchema>;

/**
 * git 情報 (サンドボックス GET /v1/files/git の応答)。branch は HEAD のブランチ名で、detached HEAD は
 * 短縮 SHA。repo の外・git が無い環境は null で、UI はチップを出さないだけにする。
 */
export const GitInfoSchema = z.object({ branch: z.string().nullable() });
export type GitInfo = z.infer<typeof GitInfoSchema>;

/**
 * テキストプレビュー (サンドボックス GET /v1/files/preview の応答)。
 * サンドボックス側の上限はバイト数で、ここは UTF-16 単位の防御。UTF-8 ではバイト数 ≥ 単位数なので通った文字列を弾かない。
 * 値は SANDBOX_MAX_PREVIEW_BYTES と揃える (変更手順は docs/file-preview.md の「上限」を参照)。
 */
export const FilePreviewSchema = z.object({ text: z.string().max(2 * 1024 * 1024) });
export type FilePreview = z.infer<typeof FilePreviewSchema>;

/**
 * アップロード応答 (サンドボックス POST /v1/files/upload の応答をそのまま返す)。
 * path はセッションの作業フォルダ相対で、raw 表示 URL はクライアントが root 相対へ変換する。
 */
export const FileUploadSchema = z.object({
  path: z.string(),
  name: z.string(),
  renamed: z.boolean(),
  size: z.number(),
});
export type FileUpload = z.infer<typeof FileUploadSchema>;

/**
 * リネーム (POST /api/files/rename) のリクエストボディ。path は root 相対のエントリ、name は 1 セグメントの新しい名前。
 * 名前の形式 (空・`.`・`..`・`/` など) とパスの検証はサンドボックスが行う。
 */
export const RenameFileBodySchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type RenameFileBody = z.infer<typeof RenameFileBodySchema>;

/**
 * リネーム応答 (サンドボックス POST /v1/files/rename の応答をそのまま返す)。
 * path は改名後のエントリのワークスペース root 相対パス。
 */
export const FileRenameSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type FileRename = z.infer<typeof FileRenameSchema>;

/**
 * ダウンロードの事前チェック (BFF GET /api/files/download/check とサンドボックス GET /v1/files/download/check の応答)。
 * ワイヤ契約の正は server/src/sandbox/protocol.ts の `SandboxDownloadCheck`。
 */
export const FileDownloadCheckSchema = z.object({
  kind: z.enum(["file", "archive"]),
  /** 保存名。ファイルはその名前、ZIP は `<フォルダ名>.zip` */
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  /** 除外規則で落とした名前 (重複なし) */
  skipped: z.array(z.string()),
});
export type FileDownloadCheck = z.infer<typeof FileDownloadCheckSchema>;

/**
 * サンドボックス GET /v1/skills の応答。ワイヤ契約の正は server/src/sandbox/protocol.ts で、
 * ここは BFF が受けた応答の検証用。
 */
export const SandboxSkillsSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      /** root 内の絶対パス (realpath) */
      path: z.string(),
      disableModelInvocation: z.boolean(),
    }),
  ),
});

/**
 * ファイルスキル (`.agents/skills`) 1 件。catalog のスキル定義と違って読み取り専用で、編集・削除・
 * エージェント割り当ての対象外 (docs/api-catalog.md)。同名は優先順位で一意化され、
 * shadowed に影になった側が入る。
 */
export const FileSkillShadowedSchema = z.object({
  /** サンドボックス絶対パス (realpath) */
  path: z.string(),
  /** root 相対 (表示用)。root の外へ解決する場合は絶対パスのまま */
  relativePath: z.string(),
});
export type FileSkillShadowed = z.infer<typeof FileSkillShadowedSchema>;

export const FileSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** ファイルスキルはサンドボックス絶対パス (realpath)、組み込みは仮想パス。モデルはこのパスを read で読む */
  path: z.string(),
  /** root 相対 (表示用)。root の外へ解決する場合は絶対パスのまま */
  relativePath: z.string(),
  /** 発見元。優先順位は project > user > builtin */
  scope: z.enum(["user", "project", "builtin"]),
  disableModelInvocation: z.boolean(),
  shadowed: z.array(FileSkillShadowedSchema),
  /** 同名の上位スコープがあり読み込まれない (組み込みだけが true になり得る) */
  overridden: z.boolean(),
  /** 組み込みのみ: ワークスペースに実体が無いため一覧へ載せる SKILL.md の全文 */
  body: z.string().optional(),
  /** 組み込みのみ: 同梱物の版 */
  version: z.string().optional(),
});
export type FileSkillInfo = z.infer<typeof FileSkillInfoSchema>;

/** GET /api/skills/files の応答 */
export const FileSkillsResponseSchema = z.object({ skills: z.array(FileSkillInfoSchema) });
export type FileSkillsResponse = z.infer<typeof FileSkillsResponseSchema>;

/**
 * セッションで使えるスキル 1 件 (GET /api/sessions/:id/skills)。設定の FileSkillInfo と違い、
 * プロジェクトスキルと Agent 割り当て (catalog) を含み、本文は持たない (送信時に取り直す)。
 * 優先順位は project > user > builtin > catalog で、負けた行は shadowed / shadowedBy で示す。
 */
export const SessionSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(["project", "user", "builtin", "catalog"]),
  /** read に渡せる場所。ファイル / 組み込み / カタログとも絶対パス (カタログは実体の無い仮想パス) */
  location: z.string(),
  /** 表示用の root 相対パス。root の外は null */
  relativePath: z.string().nullable(),
  disableModelInvocation: z.boolean(),
  /**
   * 同名の上位スコープがあり `/skill:` では選ばれない (組み込みとカタログで起こり得る)。
   * 設定用の FileSkillInfo.shadowed (隠した側の一覧) とは意味が違うので注意。
   */
  shadowed: z.boolean(),
  /** shadowed のとき、優先される側の location */
  shadowedBy: z.string().nullable(),
  /** この行が隠している側の location (同名の下位スコープ。空なら重複なし) */
  shadows: z.array(z.string()),
});
export type SessionSkillInfo = z.infer<typeof SessionSkillInfoSchema>;

/** GET /api/sessions/:id/skills の応答 */
export const SessionSkillsResponseSchema = z.object({
  sessionId: z.string(),
  /** root 相対の作業ディレクトリ ("" は root) */
  cwd: z.string(),
  /** プロジェクトスキルを探索するセッションか (未所属のスクラッチと root 直下は false) */
  projectSkills: z.boolean(),
  skills: z.array(SessionSkillInfoSchema),
});
export type SessionSkillsResponse = z.infer<typeof SessionSkillsResponseSchema>;

/**
 * GET /api/skills/session の応答。セッション未確定 (新規チャット) のプレビューなので sessionId を持たない。
 * `cwd` は未所属なら "" で、永続化されたセッションのスクラッチ (通常スペースは `.u7agent/sessions/<id>`) とは別の値。
 */
export const SessionSkillsPreviewSchema = SessionSkillsResponseSchema.omit({ sessionId: true });
export type SessionSkillsPreview = z.infer<typeof SessionSkillsPreviewSchema>;

export const PostMessageResultSchema = z.object({
  queued: z.boolean(),
  queueDepth: z.number(),
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
 * `POST /api/sessions/:id/move` の応答。移動後も会話全文は返さず、一覧の更新に必要な 3 つだけを返す。
 * `spaceId` は移動先で、`title` は一覧と同じ正規化 (未設定は「無題のセッション」) 後の値。
 */
export const SessionMoveResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  spaceId: z.string(),
});
export type SessionMoveResponse = z.infer<typeof SessionMoveResponseSchema>;

// ---------------------------------------------------------------------------
// リクエスト body スキーマ
// route が見るのは JSON の形と型だけ。必須判定と正規化 (trim / 上限 / 未知キー) は catalog が正
// ---------------------------------------------------------------------------

export const PostMessageBodySchema = z.object({
  /** 通常の送信は必須。`resendRunId` を指定した再送では本文を送らず、サーバーが保存済みの本文を使う */
  text: z.string().optional(),
  /** 添付 (root 相対。通常スペースは `<appdir>/uploads/<sessionId>/` 配下)。件数とパスの検証は attachments.ts が正 */
  attachments: z.array(z.string()).optional(),
  /** 未送信メッセージの再送。本文は保存済みの生テキストを使い、同じ run id で実行し直す */
  resendRunId: z.string().optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;

/**
 * ask_user の回答。質問数と index の対応、`skipped` の排他は store が正 (route は JSON の形だけを見る)。
 * 全質問に 1 つずつ回答が要り、一部だけの回答は 400 になる。
 */
export const AnswerQuestionBodySchema = z.object({ answers: z.array(AskUserAnswerSchema) });
export type AnswerQuestionBody = z.infer<typeof AnswerQuestionBodySchema>;

export const CreateSessionBodySchema = z.object({
  spaceId: z.string().optional(),
  agentId: z.string().optional(),
  // 未指定ならエージェント定義 → アプリ既定の順に解決する (null は 400)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  // 未指定は未所属 (cwd = root になるのは永続化なしの通常スペースだけ)。未知の id は 400
  projectId: z.string().min(1).optional(),
  // 新規チャットで選んだ通知トグルを、作成されるセッションへ引き継ぐ (未指定は false)
  notify: z.boolean().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const CreateProjectBodySchema = z.object({
  cwd: z.string(),
  name: z.string().optional(),
  create: z.boolean().optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

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
 * セッションの引っ越し先のスペース。要求元スペースは query (`sessionSpaceGuard` が照合する) で、
 * 本文は移動先だけを持つ (ガードに移動先を要求元と読ませない)。
 */
export const MoveSessionBodySchema = z.object({ spaceId: z.string().min(1) });
export type MoveSessionBody = z.infer<typeof MoveSessionBodySchema>;

/**
 * serve (UI 上の呼称は「サービス」) の状態。稼働判定は常にプローブで、記録は表示と操作権限にだけ使う。
 * `owner.kind` の `mine` / `other` は記録と「いま待受しているプロセス」が一致したときだけ立つ。
 */
export const ServeOwnerKindSchema = z.enum(["mine", "other", "unknown", "none"]);
export type ServeOwnerKind = z.infer<typeof ServeOwnerKindSchema>;

export const ServeOwnerSchema = z.object({
  kind: ServeOwnerKindSchema,
  /** `mine` / `other` のときだけ載る会話名 */
  title: z.string().optional(),
});

export const ServeCommandSchema = z.object({
  /** ワークスペース root 相対の作業ディレクトリ */
  cwd: z.string(),
  command: z.string(),
});

export const ServeStatusSchema = z.object({
  reachable: z.boolean(),
  owner: ServeOwnerSchema,
  /** 置き換えの再照合用。記録が無ければ null */
  generation: z.string().nullable(),
  /** 閲覧中の会話の作業ディレクトリの実績。無ければ null */
  command: ServeCommandSchema.nullable(),
  /**
   * 起動時に解決した環境変数の世代。一覧 API の `generation` と比べると「再起動で反映される変更」が
   * 分かる (UI は今回は説明の 1 行まで)。記録が無い / この項目より前の記録は null
   */
  secretGeneration: z.string().nullable(),
});
export type ServeStatus = z.infer<typeof ServeStatusSchema>;
export type ServeCommand = z.infer<typeof ServeCommandSchema>;

/** 設定 → ランタイム。閲覧中の会話の実績ではなく、いま公開中のサービスを返す。 */
export const RuntimeServeStatusSchema = z.object({
  reachable: z.boolean(),
  /** 起動元の会話。所属スペースが引けない (削除済み等) ときは `spaceId` を載せない */
  owner: z.object({ sessionId: z.string(), title: z.string(), spaceId: z.string().optional() }).nullable(),
  generation: z.string().nullable(),
  command: ServeCommandSchema.nullable(),
});
export type RuntimeServeStatus = z.infer<typeof RuntimeServeStatusSchema>;

export const RuntimeServeStopBodySchema = z
  .object({
    generation: z.string().min(1),
  })
  .strict();
export type RuntimeServeStopBody = z.infer<typeof RuntimeServeStopBodySchema>;

/** 起動。command はエージェントの serve ツールだけが渡す (GUI は実績をそのまま使う) */
export const ServeStartBodySchema = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1).optional(),
  generation: z.string().nullable().optional(),
});
export type ServeStartBody = z.infer<typeof ServeStartBodySchema>;

export const ServeStopBodySchema = z.object({
  sessionId: z.string().min(1),
  generation: z.string().nullable().optional(),
});
export type ServeStopBody = z.infer<typeof ServeStopBodySchema>;

// ---------------------------------------------------------------------------
// 環境変数 (作業環境 → 環境変数。docs/secrets.md)
// ---------------------------------------------------------------------------

/** 種別。型の正は secret-crypto.ts の SecretKind で、ここは同じ値であることを satisfies で固定する */
export const SecretKindSchema = z.enum(["variable", "secret"] satisfies readonly [SecretKind, ...SecretKind[]]);
export type SecretKindValue = z.infer<typeof SecretKindSchema>;

/** 一覧 / 変更後に行が返す項目。値は種別に関係なく含めない (値は detail の変数だけ) */
export const SecretItemSchema = z.object({
  secretId: z.string(),
  name: z.string(),
  kind: SecretKindSchema,
  /** epoch ms */
  updatedAt: z.number(),
});
export type SecretItem = z.infer<typeof SecretItemSchema>;

/** 変更フォーム用。`value` は変数のときだけ入り、シークレットでは省略される */
export const SecretDetailSchema = SecretItemSchema.extend({ value: z.string().optional() });
export type SecretDetailResponse = z.infer<typeof SecretDetailSchema>;

export const SecretsListSchema = z.object({
  items: z.array(SecretItemSchema),
  /** 変更のたびに変わる世代。serve の `secretGeneration` と比べて「再起動で反映」を出せる */
  generation: z.string(),
  /** cwd が登録プロジェクトのディレクトリか (「このプロジェクトの設定です」の根拠) */
  projectScoped: z.boolean(),
});
export type SecretsListResponse = z.infer<typeof SecretsListSchema>;

export const SecretMutationResponseSchema = z.object({
  item: SecretItemSchema,
  /** 前後の空白 / 改行を除去したか。UI はそのときだけ 1 行の注記を出す */
  trimmed: z.boolean(),
  generation: z.string(),
});
export type SecretMutationResponse = z.infer<typeof SecretMutationResponseSchema>;

export const SecretRemovalResponseSchema = z.object({ removed: z.boolean(), generation: z.string() });
export type SecretRemovalResponse = z.infer<typeof SecretRemovalResponseSchema>;

/** 要求元は会話 (sessionId) か、まだ会話が無いプロジェクト起点の新規会話 (projectId) のどちらか一方 */
const secretScopeShape = {
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
};

/** 登録。名前 / 値の規則 (上限・拒否リスト・trim) は secrets.ts を正とする */
export const CreateSecretBodySchema = z.object({
  ...secretScopeShape,
  kind: SecretKindSchema,
  name: z.string(),
  value: z.string(),
});
export type CreateSecretBody = z.infer<typeof CreateSecretBodySchema>;

/** 値の上書き (名前と種別は変えられない) */
export const UpdateSecretBodySchema = z.object({ ...secretScopeShape, value: z.string() });
export type UpdateSecretBody = z.infer<typeof UpdateSecretBodySchema>;

/** 通知設定の更新。キー省略は現在値の維持、webhookUrl / baseUrl の null は解除 */
export const UpdateNotificationsBodySchema = z.object({
  enabled: z.boolean().optional(),
  webhookUrl: z.string().nullish(),
  baseUrl: z.string().nullish(),
});
export type UpdateNotificationsBody = z.infer<typeof UpdateNotificationsBodySchema>;

/** アーカイブ除外名の更新。一覧は丸ごと差し替える（空配列は「除外なし」を表す） */
export const UpdateArchiveSettingsBodySchema = z.object({ excludeNames: z.array(z.string()) });
export type UpdateArchiveSettingsBody = z.infer<typeof UpdateArchiveSettingsBodySchema>;

// 全キー任意にするのは、空 body の PATCH を no-op として通し、必須判定を catalog の文言のまま残すため。
// null は「指定解除」、キー省略は「現在値の維持」で、どちらも catalog が解釈する。
const agentBodyShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skillIds: z.array(z.string()).nullish(),
  icon: z.string().nullish(),
  model: ModelRefSchema.nullish(),
  thinkingLevel: ThinkingLevelSchema.nullish(),
  suggestions: z.array(AgentSuggestionSchema).nullish(),
};

export const CreateAgentBodySchema = z.object(agentBodyShape);
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

export const UpdateAgentBodySchema = z.object(agentBodyShape);
export type UpdateAgentBody = z.infer<typeof UpdateAgentBodySchema>;

const skillBodyShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
};

export const CreateSkillBodySchema = z.object(skillBodyShape);
export type CreateSkillBody = z.infer<typeof CreateSkillBodySchema>;

/**
 * 更新は旧フィールド名 `prompt` を明示的に拒否する。未知キーとして strip すると「`body` のキー省略」
 * に化け、本文が変わらないまま 200 を返して成功と誤認させる (作成は `body` 必須なので同じ入力でも 400)。
 */
export const UpdateSkillBodySchema = z.object({ ...skillBodyShape, prompt: z.never().optional() });
export type UpdateSkillBody = z.infer<typeof UpdateSkillBodySchema>;

// ---------------------------------------------------------------------------
// SSE イベント (sessions.ts の emit 呼び出しを正とする)
// ---------------------------------------------------------------------------

export const EventDataSchemas = {
  // `startedAt` は payload の `run.startedAt` と同じ値。クライアントは受信時刻ではなくこれを使う
  // (切断中に始まった run の `run_start` がリプレイされても開始時刻がぶれない)
  run_start: z.object({ runId: z.string(), prompt: z.string(), startedAt: z.number() }),
  text: z.object({ delta: z.string() }),
  tool_start: z.object({
    id: z.string(),
    name: z.string(),
    args: z.string(),
    skill: SkillLoadSchema.optional(),
    questions: z.array(AskUserQuestionSchema).optional(),
    /** BFF がイベントの到着時刻で測った開始時刻。`run.toolCalls[].startedAt` と同じ値 */
    startedAt: z.number().optional(),
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
  status: z.object({ state: z.string(), text: z.string() }),
  queued: z.object({
    position: z.number(),
    queueDepth: z.number(),
    prompt: z.string(),
  }),
  // 停止で破棄した待機メッセージの run id。クライアントが「未送信」へ切り替えるために使う
  queue_cleared: z.object({ runIds: z.array(z.string()).optional() }).strict(),
  // assistant の message_end ごとに 1 件。usage はプロバイダが報告したときだけ入る
  usage: z.object({
    usage: UsageSchema.optional(),
    metrics: MessageMetricsSchema.optional(),
    context: ContextUsageSchema.optional(),
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

/**
 * GET / PUT /api/settings/web-search。`web_search` の有効 / 無効と既定 provider を持つ。
 * 行が無い = 既定（有効 / 先頭の provider）なので、初期状態でも `enabled: true` が返る。
 */
export const WebSearchProviderIdSchema = z.enum(WEB_SEARCH_PROVIDER_IDS);
export type WebSearchProviderId = z.infer<typeof WebSearchProviderIdSchema>;

/** provider 1 件の公開情報。`host` は外部送信先を画面で隠さないために出し、キーの値は返さない */
export const WebSearchProviderSchema = z.object({
  id: WebSearchProviderIdSchema,
  name: z.string(),
  host: z.string(),
  keyless: z.boolean(),
  /** キーが登録済みか。keyless の provider は常に true */
  configured: z.boolean(),
});
export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;

export const WebSearchSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  /** 既定の provider。設定した値が次の検索から使われる */
  provider: WebSearchProviderIdSchema,
  providers: z.array(WebSearchProviderSchema),
  /** 無効のときに `web_search` がモデルへ返す固定文言。画面は同じ文言をそのまま出す */
  disabledMessage: z.string(),
});
export type WebSearchSettingsResponse = z.infer<typeof WebSearchSettingsResponseSchema>;

/** 変更系（PUT / DELETE）の応答。即時反映なので `applied` だけを返す（コンテンツ生成と同じ契約） */
export const WebSearchMutationResponseSchema = WebSearchSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type WebSearchMutationResponse = z.infer<typeof WebSearchMutationResponseSchema>;

/** トグルの変更。既存セッションにも次の呼び出しから効く（ツール側が毎回読む） */
export const UpdateWebSearchBodySchema = z.object({
  enabled: z.boolean(),
});
export type UpdateWebSearchBody = z.infer<typeof UpdateWebSearchBodySchema>;

/** 既定 provider の変更。provider の選択と「既定にする」は同じ操作にする（GUI もそう振る舞う） */
export const UpdateWebSearchProviderBodySchema = z.object({
  provider: WebSearchProviderIdSchema,
});
export type UpdateWebSearchProviderBody = z.infer<typeof UpdateWebSearchProviderBodySchema>;

/** provider の APIキーの登録・上書き。長さは provider_credentials / 画像と同じ */
export const UpdateWebSearchKeyBodySchema = z.object({
  apiKey: z.string().min(PROVIDER_API_KEY_MIN_LENGTH).max(PROVIDER_API_KEY_MAX_LENGTH),
});
export type UpdateWebSearchKeyBody = z.infer<typeof UpdateWebSearchKeyBodySchema>;

/** 変更系の失敗応答（何も変わっていない） */
export const WebSearchMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type WebSearchMutationError = z.infer<typeof WebSearchMutationErrorSchema>;
