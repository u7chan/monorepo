/** API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

export const RunStatusSchema = z.enum(["idle", "running", "queued", "completed", "stopped", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

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

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  isError: z.boolean(),
  done: z.boolean(),
  output: z.string(),
  /** ライブでスキル読み込みだったときだけ載る (履歴側は ChatMessage.skillLoads) */
  skill: SkillLoadSchema.optional(),
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
  /** このバブルに出す分 (本文を持たない read だけのターンからの繰り上げ分を含む)。無ければキーを省略 */
  skillLoads: z.array(SkillLoadSchema).optional(),
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
  tool_start: z.object({ id: z.string(), name: z.string(), args: z.string(), skill: SkillLoadSchema.optional() }),
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
