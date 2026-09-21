/** API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

export const RunStatusSchema = z.enum(["idle", "running", "queued", "completed", "stopped", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const SkillDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
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

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  isError: z.boolean(),
  done: z.boolean(),
  output: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const RunPayloadSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string(),
  toolCalls: z.array(ToolCallSchema),
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
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

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
  sessionId: z.string(),
  piSessionId: z.string(),
  /** rootCwd 相対の作業ディレクトリ (未所属は "" = root) */
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
  queueDepth: z.number(),
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
  sessionId: z.string(),
  title: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  status: RunStatusSchema,
  queueDepth: z.number(),
  messageCount: z.number(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  model: z.string().optional(),
  projectId: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ModelOptionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  supportsThinking: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

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
  /** 明示 PI_MODEL が利用不能なときの理由 (ready は true のまま) */
  defaultModelError: z.string().optional(),
  tools: z.array(z.string()).optional(),
  availabilityError: z.string().optional(),
  sandboxConfigured: z.boolean().optional(),
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
 * テキストプレビュー (サンドボックス GET /v1/files/preview の応答)。
 * サンドボックス側の上限はバイト数で、ここは UTF-16 単位の防御。UTF-8 ではバイト数 ≥ 単位数なので通った文字列を弾かない。
 */
export const FilePreviewSchema = z.object({ text: z.string().max(256 * 1024) });
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

// ---------------------------------------------------------------------------
// リクエスト body スキーマ
// route が見るのは JSON の形と型だけ。必須判定と正規化 (trim / 上限 / 未知キー) は catalog が正
// ---------------------------------------------------------------------------

export const PostMessageBodySchema = z.object({
  text: z.string(),
  /** 添付 (root 相対の `<appdir>/uploads/<sessionId>/` 配下)。件数とパスの検証は attachments.ts が正 */
  attachments: z.array(z.string()).optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;

export const CreateSessionBodySchema = z.object({
  agentId: z.string().optional(),
  // 未指定ならエージェント定義 → アプリ既定の順に解決する (null は 400)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  // 未指定は未所属 (cwd = root)。未知の id は 400
  projectId: z.string().min(1).optional(),
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

export const ReplaceCatalogBodySchema = z.object({
  agents: z.array(z.unknown()),
  skills: z.array(z.unknown()),
});
export type ReplaceCatalogBody = z.infer<typeof ReplaceCatalogBodySchema>;

// 全キー任意にするのは、空 body の PATCH を no-op として通し、必須判定を catalog の文言のまま残すため。
// null は「指定解除」、キー省略は「現在値の維持」で、どちらも catalog が解釈する。
const agentBodyShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skillIds: z.array(z.string()).nullish(),
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
  prompt: z.string().optional(),
};

export const CreateSkillBodySchema = z.object(skillBodyShape);
export type CreateSkillBody = z.infer<typeof CreateSkillBodySchema>;

export const UpdateSkillBodySchema = z.object(skillBodyShape);
export type UpdateSkillBody = z.infer<typeof UpdateSkillBodySchema>;

// ---------------------------------------------------------------------------
// SSE イベント (sessions.ts の emit 呼び出しを正とする)
// ---------------------------------------------------------------------------

export const EventDataSchemas = {
  // `startedAt` は payload の `run.startedAt` と同じ値。クライアントは受信時刻ではなくこれを使う
  // (切断中に始まった run の `run_start` がリプレイされても開始時刻がぶれない)
  run_start: z.object({ runId: z.string(), prompt: z.string(), startedAt: z.number() }),
  text: z.object({ delta: z.string() }),
  tool_start: z.object({ id: z.string(), name: z.string(), args: z.string() }),
  tool_end: z.object({
    id: z.string(),
    name: z.string().optional(),
    isError: z.boolean(),
    output: z.string(),
  }),
  status: z.object({ state: z.string(), text: z.string() }),
  queued: z.object({
    position: z.number(),
    queueDepth: z.number(),
    prompt: z.string(),
  }),
  queue_cleared: z.object({}).strict(),
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
    error: z.string().optional(),
    messageCount: z.number().optional(),
    // message_end 時点の context は SDK が履歴へ入れる前で古いため、確定値は run_end で配る
    context: ContextUsageSchema.optional(),
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
