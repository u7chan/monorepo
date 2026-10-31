/** API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import { PROVIDER_FAILURE_CODES } from "./provider-failure";
import { WEB_SEARCH_PROVIDER_IDS } from "./web-search-providers";
import type { SandboxLandlockStatus, SandboxRuntimeCommand, SandboxRuntimeEnvironment } from "./sandbox/protocol";
import type { SecretKind } from "./secret-crypto";

export const SpaceSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.number() });
export type Space = z.infer<typeof SpaceSchema>;
export const CreateSpaceBodySchema = z.object({ name: z.string().trim().min(1).max(80) });
/** PATCH /api/spaces/:id。入力の規則は作成と同じ (重複名は許可し、同一性は id が持つ) */
export const RenameSpaceBodySchema = CreateSpaceBodySchema;

export const RunStatusSchema = z.enum(["idle", "running", "queued", "compacting", "completed", "stopped", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * ランが終端したときの結末。`RunStatusSchema` の部分集合で、ターンの結末の表示 (`Done` /
 * `Stopped` / `Failed`) に使う。終端以外 (`idle` / `running` / `queued` / `compacting`) は載せない
 */
export const RunOutcomeSchema = z.enum(["completed", "stopped", "error"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** 会話タイトルの由来。auto = 依頼本文、ai = AI 要約、manual = 手動改名 */
export const TitleOriginSchema = z.enum(["auto", "ai", "manual"]);
export type TitleOrigin = z.infer<typeof TitleOriginSchema>;

export const TitleAttemptStateSchema = z.enum(["pending", "done", "failed", "skipped"]);
export type TitleAttemptState = z.infer<typeof TitleAttemptStateSchema>;

/** AI 要約を実行しなかった理由。画面の文言は client 側で写す */
export const TitleSkipReasonSchema = z.enum([
  "disabled",
  "model-unset",
  "manual",
  "no-request",
  "cancelled",
  "settings-changed",
  "not-ready",
  "interrupted",
]);
export type TitleSkipReason = z.infer<typeof TitleSkipReasonSchema>;

export const TitleAttemptSchema = z.object({
  runId: z.string().min(1),
  at: z.number().finite(),
  state: TitleAttemptStateSchema,
  /** 自動要約 / 会話メニューからの明示的な再要約 */
  trigger: z.enum(["auto", "manual"]).optional(),
  /** 予約時に確定したモデル (`provider/id`) */
  model: z.string().optional(),
  /** 予約時に確定した実効 Effort */
  thinkingLevel: ThinkingLevelSchema.optional(),
  /** 予約時の設定世代。保存後に設定が変わった結果は適用しない */
  generation: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costTotal: z.number().optional(),
  /** 生成にかかった時間 (順番待ちを含む)。画面の確認用 */
  durationMs: z.number().optional(),
  /** 失敗理由 (マスク済み・長さ上限あり)。依頼本文と生成タイトルは含めない */
  error: z.string().optional(),
  /** 実行しなかった理由 (skipped のとき) */
  skipReason: TitleSkipReasonSchema.optional(),
});
export type TitleAttempt = z.infer<typeof TitleAttemptSchema>;

/** 会話タイトルの由来と最新の AI 要約試行。タイトル本文は `title` が持つ */
export const SessionTitleSummarySchema = z.object({
  origin: TitleOriginSchema,
  attempt: TitleAttemptSchema.optional(),
});
export type SessionTitleSummary = z.infer<typeof SessionTitleSummarySchema>;

/** 設定画面の「動作確認」の結果。タイトルは保存しない */
export const TitleSummaryTestResponseSchema = z.object({
  ok: z.boolean(),
  title: z.string().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costTotal: z.number().optional(),
  durationMs: z.number(),
});
export type TitleSummaryTestResponse = z.infer<typeof TitleSummaryTestResponseSchema>;

/** 会話メニューからの再要約の結果。生成に失敗しても現在のタイトルと試行を返す */
export const SessionTitleSummaryResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  titleSummary: SessionTitleSummarySchema,
});
export type SessionTitleSummaryResponse = z.infer<typeof SessionTitleSummaryResponseSchema>;

/** 認証済みモデルの provider/id 参照 (SDK の Model そのものではない) */
export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/**
 * 入力欄のチップ 1 件。label がボタン文言、prompt が送信文字列。
 * 定型プロンプトのマスタ (`PromptRefSchema`) と、マスタに属さない引き継ぎのチップが同じ形を使う。
 */
export const AgentSuggestionSchema = z.object({
  label: z.string(),
  prompt: z.string(),
});
export type AgentSuggestion = z.infer<typeof AgentSuggestionSchema>;

/** マスタの種別。組み込みは閲覧・参照のみ、自作だけが編集・削除できる */
export const PromptKindSchema = z.enum(["builtin", "custom"]);
export type PromptKind = z.infer<typeof PromptKindSchema>;

/**
 * マスタのラベル・本文・ID の上限。ラベルと本文は旧 `suggestions` の編集上限を引き継ぐ。
 * エージェント 1 体の参照上限は `AGENT_PROMPT_LIMIT` (マスタ全体には上限を掛けない)。
 */
export const AGENT_PROMPT_LIMIT = 6;
export const PROMPT_LABEL_MAX = 60;
export const PROMPT_TEXT_MAX = 500;
export const PROMPT_ID_MAX = 100;

/**
 * エージェントに解決済みで載る定型プロンプト 1 件。表示の同一性は `id` で持ち、
 * 同じ本文の別マスタを本文でまとめない。
 */
export const PromptRefSchema = z.object({
  id: z.string(),
  kind: PromptKindSchema,
  label: z.string(),
  prompt: z.string(),
});
export type PromptRef = z.infer<typeof PromptRefSchema>;

/** マスタの使用先 1 件。組み込みの汎用アシスタントの固定参照も含める */
export const PromptUsageSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  /** 組み込みエージェントの固定参照か (DB の紐づけではない) */
  builtin: z.boolean(),
});
export type PromptUsage = z.infer<typeof PromptUsageSchema>;

/** `GET /api/prompts` の 1 件。使用先を伴い、削除できない理由を画面が説明できる */
export const PromptDefSchema = PromptRefSchema.extend({ usedBy: z.array(PromptUsageSchema) });
export type PromptDef = z.infer<typeof PromptDefSchema>;

/** `GET /api/prompts` の応答。並びはサーバーが決める (組み込みが先、自作は保存した順) */
export const PromptsResponseSchema = z.object({ prompts: z.array(PromptDefSchema) });
export type PromptsResponse = z.infer<typeof PromptsResponseSchema>;

/**
 * 並べ替えで受ける id の上限。形と上限だけを見る点は `ReorderAgentsBodySchema` と同じで、
 * 未知の id・重複・組み込みの扱いは `PromptCatalog.reorder` が正。
 */
export const PROMPT_ORDER_IDS_MAX = 500;

export const ReorderPromptsBodySchema = z.object({ ids: z.array(z.string()).max(PROMPT_ORDER_IDS_MAX) });
export type ReorderPromptsBody = z.infer<typeof ReorderPromptsBodySchema>;

/** `POST /api/prompts` の応答。作成した 1 件を使用先 (空) つきで返す */
export const PromptResponseSchema = z.object({ prompt: PromptDefSchema });
export type PromptResponse = z.infer<typeof PromptResponseSchema>;

/**
 * 使用中の自作マスタの削除拒否 (409) の応答。どこで使われているかを画面がそのまま出せるようにする。
 * データは変更しない (docs/api-catalog.md)。
 */
export const PromptDeleteConflictSchema = z.object({ error: z.string(), usedBy: z.array(PromptUsageSchema) });
export type PromptDeleteConflict = z.infer<typeof PromptDeleteConflictSchema>;

/**
 * スキル許可リスト (`commonSkillNames` / `builtinSkillNames`) の上限。配列全体は body の
 * 64 KiB でも押さえられるが、中身を正規化する防御線としてここにも置く。1 件の長さはワークスペースの
 * 1 セグメント名の上限 (`sandbox/protocol.ts` の `SANDBOX_MAX_ENTRY_NAME_LENGTH`) と揃える
 * (値は import せず複製。揃え方は `FilePreviewSchema` と同じ)。
 */
export const SKILL_NAMES_MAX = 200;
export const SKILL_NAME_MAX = 200;

/**
 * ツール許可リストの上限。スキル名の上限 (`SKILL_NAME_MAX`) はワークスペースの 1 セグメント名を
 * 根拠にしているが、ツール名に同じ根拠は無い (SDK 組込みとアプリの定義が決める) ため別に持つ。
 * どちらも名前の保存を弾くための防御線で、値そのものに意味は無い。
 */
export const TOOL_NAMES_MAX = 200;
export const TOOL_NAME_MAX = 200;

/**
 * ツール 1 件の種別。`sandbox` はサンドボックスで動く作業ツール、`app` は BFF ローカルのツール。
 * 画面のグループ分けに使う (`docs/api-catalog.md#ツール許可リスト`)。
 */
export const ToolGroupSchema = z.enum(["sandbox", "app"]);
export type ToolGroup = z.infer<typeof ToolGroupSchema>;

/**
 * アプリ側でツールを使えない理由のコード。文言はクライアントの lib が持ち、応答にはコードだけを載せる
 * (既存の分担は `client/src/lib/fileSkills.ts` / `client/src/lib/settingsNotes.ts`)。
 */
export const ToolUnavailableReasonSchema = z.enum(["deploy_allowlist", "app_disabled", "no_key"]);
export type ToolUnavailableReason = z.infer<typeof ToolUnavailableReasonSchema>;

/**
 * `GET /api/agents` が返すツール 1 件 (`builtinSkills` と同じ位置づけ)。`available` は取得時点の
 * アプリ側の実効で、エージェントの許可リストは掛けない (許可リストと一緒に画面が判断する)。
 * `reason` は `available: false` のときだけ載る。
 */
export const ToolCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  group: ToolGroupSchema,
  available: z.boolean(),
  reason: ToolUnavailableReasonSchema.optional(),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

export const AgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  /**
   * 共通スキルの許可リスト。未指定 = 全可視、`[]` = すべて OFF (この 2 つは混同しない)。
   * プロジェクト / 組み込みのスキルは対象外 (docs/api-catalog.md)。
   */
  commonSkillNames: z.array(z.string()).optional(),
  /**
   * 組み込みスキルの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (この 2 つは混同しない)。
   * プロジェクト / 共通のスキルは対象外 (docs/api-catalog.md#組み込みスキル)。
   */
  builtinSkillNames: z.array(z.string()).optional(),
  /**
   * 組み込みスキルを自然文で発火させるか。未指定 = 発火する (既定)。false なら組み込みスキルを
   * `/skill:` とスキルボタンからのみ起動する (docs/api-catalog.md#自然文での発火)。
   */
  allowNaturalInvocationBuiltin: z.boolean().optional(),
  /**
   * ファイルスキル (共通 `.agents/skills` とプロジェクト `<cwd>/.agents/skills`) を自然文で発火させるか。
   * 未指定 = 発火する (既定)。組み込み側とは独立で、片方の false は他方へ波及しない。
   */
  allowNaturalInvocationFile: z.boolean().optional(),
  /**
   * ツールの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (この 2 つは混同しない)。実効は
   * アプリ側の可否との積で、アプリ側が止めているツールは許可リストに入れても使えない
   * (docs/api-catalog.md#ツール許可リスト)。
   */
  toolNames: z.array(z.string()).optional(),
  /** webp / png の data URL。未指定のときはキー自体を省略する (null は保存・応答に現れない) */
  icon: z.string().optional(),
  // 未指定のときはキー自体を省略する (null は保存・応答に現れない)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  /**
   * 空の会話に出す定型プロンプト (参照先マスタを解決した値)。並びが表示順で、表示の同一性は `id`。
   * 未指定なら firstview のボタンを出さない (アプリ既定のフォールバックは持たない)。
   */
  prompts: z.array(PromptRefSchema).optional(),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

/**
 * アプリに同梱する組み込みスキル 1 件。エージェント定義の `builtinSkillNames`
 * でエージェント別に外すため、スキル欄の行に使う。
 */
export const BuiltinSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** 同梱物の版。SKILL.md を変えたら上がる (builtin-skills.ts の VERSIONS) */
  version: z.string(),
});
export type BuiltinSkillInfo = z.infer<typeof BuiltinSkillInfoSchema>;

/**
 * GET `/api/agents` の応答。`builtinAgent` はサーバー所有の汎用エージェントで、
 * `agents` (ユーザー定義) には含まれない。サーバーは常にオブジェクトを返し、
 * `null` はクライアントが取得前に持つ初期状態だけを表す。
 */
export const CatalogResponseSchema = z.object({
  agents: z.array(AgentDefSchema),
  builtinAgent: AgentDefSchema.nullable(),
  builtinSkills: z.array(BuiltinSkillInfoSchema),
  /** アプリが扱うツールの一覧 (`builtinSkills` と同じく、エージェント定義ではない) */
  tools: z.array(ToolCatalogEntrySchema),
  /**
   * 参照できる定型プロンプトのマスタ一覧 (選択肢)。エージェントに解決済みで載る `prompts` とは別で、
   * こちらは全件。並びはサーバーが決める (組み込みが先、その中は作成順)
   */
  prompts: z.array(PromptRefSchema),
});
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

/**
 * セッション作成時に meta へ固定するエージェントのスナップショット。
 * スキルの実体はファイル側の現行定義を使い、ここには割り当てを保存しない。
 */
export const AgentPayloadInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** 共通スキルの許可リスト。未指定 = 全可視、`[]` = すべて OFF (未指定のときはキーを省略する) */
  commonSkillNames: z.array(z.string()).optional(),
  /** 組み込みスキルの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (未指定のときはキーを省略する) */
  builtinSkillNames: z.array(z.string()).optional(),
  /**
   * 組み込みスキルを自然文で発火させるか。未指定 = 発火する (既定)。false のときだけキーを載せる。
   * セッション作成時のスナップショットで、定義を編集しても復元後の会話は変わらない
   */
  allowNaturalInvocationBuiltin: z.boolean().optional(),
  /** ファイルスキル (共通 / プロジェクト) 側の同じスナップショット値。false のときだけキーを載せる */
  allowNaturalInvocationFile: z.boolean().optional(),
  /**
   * ツールの許可リスト。未指定 = 全部 ON、`[]` = すべて OFF (未指定のときはキーを省略する)。
   * セッション作成時のスナップショットで、定義を編集しても復元後の会話は変わらない
   */
  toolNames: z.array(z.string()).optional(),
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
   * 応答を生成したモデル (`provider/model`)。null はモデル情報なし、未指定は旧サーバー。
   * 欠けた値を現在のセッションモデルで補わない (別のモデルで生成した応答に誤って付く)
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
   * assistant を生成したモデル (`provider/model`)。null はモデル情報なし (旧履歴 / 未報告)、
   * 未指定は旧サーバー。user は持たない
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
   * entry を本文一致に依らず対応付ける。旧サーバーは載せない
   */
  sendId: z.string().optional(),
  /**
   * user メッセージを注入した run の id。同じ実行へ複数の送信が属するため、送信の識別には使わない。
   * 旧サーバー / 対応を失った履歴では載らない
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
   * 合わせた並びの index + 1 (SSE `queued` の `position` と同じ意味)。旧サーバーは載せない
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

/**
 * SSE の `resync` を配った理由。`attempt_discarded` は失敗試行の取り消し (SDK の context_edit) で、
 * 未確定のストリーミング応答を表示から捨てる唯一の理由。省略は同じ実行の継続を表す
 */
export const ResyncReasonSchema = z.enum(["attempt_discarded"]);
export type ResyncReason = z.infer<typeof ResyncReasonSchema>;

export const SessionPayloadSchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  piSessionId: z.string(),
  /** rootCwd 相対の作業ディレクトリ (未所属は所属スペースのスクラッチ。"" = root は永続化なしの既定スペースだけ) */
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
  /** 分岐元の会話 id。分岐した会話だけが載せ、親のタイトルは一覧から引く (旧サーバーは省略する) */
  parentSessionId: z.string().optional(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

/** 作業ディレクトリ単位の serve 成功実績。一覧の会話と稼働記録の両方がこの形で cwd とコマンドを持つ */
export const ServeCommandSchema = z.object({
  /** ワークスペース root 相対の作業ディレクトリ */
  cwd: z.string(),
  command: z.string(),
});
export type ServeCommand = z.infer<typeof ServeCommandSchema>;

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

/**
 * GET / PUT `/api/notifications` の応答。保存済み URL もその断片も返さない (write-only)。
 * `configured` は暗号文の有無、`webhookAvailable` は復号できて送信に使えるかで、`webhookEvaluated` は
 * 「復号を試したか」を表す (未評価を誤鍵・破損と断定しない)。
 */
export const NotificationsResponseSchema = z.object({
  enabled: z.boolean(),
  askUser: z.boolean(),
  provider: z.literal("discord"),
  configured: z.boolean(),
  /** Webhook URL を復号でき、送信に使える */
  webhookAvailable: z.boolean(),
  /** 復号を評価済みか。false は「まだ確認できていない」で、失敗とは区別する */
  webhookEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未設定のときは null */
  webhookErrorMessage: z.string().nullable(),
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

/**
 * GET / PUT / DELETE `/api/settings/shared-content-exclusions` の応答。形はアーカイブの設定と同じで、
 * 一覧エディタも同じ部品を使う（既定値・適用範囲・保存先だけが違う）。
 */
export const SharedContentExclusionsResponseSchema = ArchiveSettingsResponseSchema;
export type SharedContentExclusionsResponse = z.infer<typeof SharedContentExclusionsResponseSchema>;

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

/** OAuth サインインで貼り付ける URL / コードの上限。中身の検証は SDK が行うので、長さだけを境界にする */
export const OAUTH_LOGIN_CODE_MAX_LENGTH = 4_096;

/** 資格情報の種別。SDK が見ている値と、auth.json の保存値 (表示専用) の両方に使う */
export const CredentialKindSchema = z.enum(["oauth", "api_key"]);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/**
 * 設定 → モデルの OAuth サインインの状態。進行中の認可 URL はこの state としてだけクライアントへ渡し、
 * 完了・失敗・キャンセルでは落とす。生の例外文言・トークン・client_id はどのフィールドにも載せない。
 */
export const OAuthLoginStateSchema = z.object({
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  /** 進行中に開く URL (認可 URL / デバイスコードの確認 URL)。running 以外と未発行は null */
  authUrl: z.string().nullable(),
  /** 進行中の主文 (ブラウザ操作の案内。画面用の固定文言) */
  instructions: z.string().nullable(),
  /** 進行中の補助行 (画面用の固定文言)。主文を置き換えず、併記する */
  progress: z.string().nullable(),
  /** 貼り付け待ちの入力欄。null = 入力を受け付けていない */
  input: z.object({ message: z.string(), placeholder: z.string() }).nullable(),
  /** デバイスコード方式のユーザーコード。null = この方式ではない */
  userCode: z.string().nullable(),
  /** failed のときの画面用の固定文言。null = 失敗以外 */
  error: z.string().nullable(),
});
export type OAuthLoginState = z.infer<typeof OAuthLoginStateSchema>;

/** 設定 → モデルの 1 プロバイダー行。認証状態は出所だけで、値・ラベル・生の認証エラーは含めない。 */
export const ProviderAuthSettingSchema = z.object({
  provider: z.string(),
  name: z.string(),
  auth: RuntimeAuthSchema,
  /** provider_credentials に行がある (保存済みの希望状態) */
  managed: z.boolean(),
  /** provider_credentials.updatedAt (epoch ms)。null = 行が無い / 移行前の行で不明 */
  keyUpdatedAt: z.number().nullable(),
  /** 保存済みのキーを復号でき、SDK へ適用できる。managed でも false になり得る */
  keyAvailable: z.boolean(),
  /**
   * 復号を評価済みか。`managed: true` / `keyEvaluated: false` は「保存済みだが復号をまだ確認していない」で、
   * 誤鍵・破損と断定しない。評価は起動・保存 / 置換・再同期・再起動でだけ行い、GET では行わない。
   */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未保存のときは null */
  keyErrorMessage: z.string().nullable(),
  /** auth.apiKey.login を持ち、この画面からキーを登録できる */
  canSetApiKey: z.boolean(),
  supportsOAuth: z.boolean(),
  /**
   * この画面でサインインを完了できる provider か。SDK の OAuth flow が求める対話は静的な metadata に
   * 現れないため、サーバーの許可リストで判定する。**任意**で、クライアントは未指定を「サインインできない」
   * として扱う (fail-closed)。OAuth を持つかどうか (`supportsOAuth`) とは別。
   */
  canSignInHere: z.boolean().optional(),
  /**
   * SDK が見ている資格情報の種別 (ModelRuntime.isUsingOAuth)。null = 認証なし。runtime overlay があるときは
   * overlay の api_key になり、auth.json の保存値は見えない (その差は hiddenStoredOAuth が表す)。
   */
  credentialKind: CredentialKindSchema.nullable(),
  /**
   * provider の `oauth.loginLabel` (例: Sign in with ChatGPT)。OAuth の表示名にだけ使う静的 metadata で、
   * トークン・client_id・認可 URL は含めない。
   */
  oauthLoginLabel: z.string().nullable(),
  /**
   * auth.source が runtime のとき、auth.json の OAuth がこの画面のキーに覆われている印。表示専用で、
   * auth.json を読めない / 壊れているときは false (不明) へ縮退させ、認証解決には使わない。
   */
  hiddenStoredOAuth: z.boolean(),
  /** 現在のカタログに provider が無い (DB 行にしか無い) */
  orphan: z.boolean(),
  /**
   * 設定 → モデルで作ったカスタムプロバイダー。通常のプロバイダー一覧からは除外し、
   * 専用セクションと「モデルを選ぶ」タブの候補だけが使う。**このプロセスで register した id だけ**に付け、
   * built-in / `models.json` と衝突して登録できなかった行の runtime entry には付けない。未指定は false。
   */
  custom: z.boolean().optional(),
  /**
   * OAuth サインインの進行状態。null = 進行中も直近の結果も無い。このプロセスのメモリだけが持ち、
   * 再起動で消える。認可 URL は running の間だけ載る。
   */
  login: OAuthLoginStateSchema.nullable(),
  /** このプロセスの SDK 反映が未完了 (apply = 未適用 / remove = 削除未反映) */
  degraded: z.enum(["apply", "remove"]).optional(),
  /**
   * 人間用メモ。provider_memos の行と同じで、null = 未設定。キーの登録有無 (managed) とは独立する。
   * 秘密情報ではないので、マスカーにも載せない (docs/secrets.md)。
   */
  memo: z.string().nullable(),
});
export type ProviderAuthSetting = z.infer<typeof ProviderAuthSettingSchema>;

/**
 * カスタムプロバイダーのモデル。1 provider = 1 model で、contextWindow は入力を必須にする
 * (OpenAI 互換 API からは取得できないため既定値を置かない)。
 */
export const CustomProviderModelSchema = z.object({
  id: z.string(),
  contextWindow: z.number().int(),
  maxTokens: z.number().int(),
});
export type CustomProviderModel = z.infer<typeof CustomProviderModelSchema>;

/**
 * 設定 → モデルのカスタムプロバイダー 1 件。**キーは返さない** (有無だけを hasKey で表す)。
 * api は v1 では openai-completions 固定。定義はアプリ DB が正で、GET は復号しない。
 */
export const CustomProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  api: z.literal("openai-completions"),
  model: CustomProviderModelSchema,
  hasKey: z.boolean(),
  /**
   * このプロセスの SDK 反映が未完了の印。`apply` は DB 行はあるが register / キー適用が済んでいない、
   * `remove` は削除待ち tombstone。未指定は「反映済み」。
   */
  degraded: z.enum(["apply", "remove"]).optional(),
  /** degraded の固定文言 (master key 未設定 / 復号不能 / id 衝突)。クライアントは原因を推測しない */
  degradedMessage: z.string().nullable().optional(),
});
export type CustomProviderSummary = z.infer<typeof CustomProviderSummarySchema>;

/**
 * `/models` の probe の失敗分類。失敗も 200 の結果として返す (HTTP エラーにすると分類と
 * `httpStatus` がクライアントの汎用エラー経路へ落ちる)。
 */
export const CustomProviderProbeFailureSchema = z.enum([
  "unauthorized",
  "not_found",
  "http_error",
  "redirected",
  "invalid_response",
  "timeout",
  "unreachable",
]);
export type CustomProviderProbeFailure = z.infer<typeof CustomProviderProbeFailureSchema>;

/**
 * カスタムプロバイダーのモデル一覧取得の結果。`failure === null` が成功で、`message` も `httpStatus` も
 * null になる。失敗は `models: []` で `message` が非 null。**キーは載せない**。
 */
export const CustomProviderProbeResponseSchema = z.object({
  checkedAt: z.number(),
  baseUrl: z.string(),
  failure: CustomProviderProbeFailureSchema.nullable(),
  /** 接続先が返した HTTP status のうち 400 以上だけ (3xx / 2xx は null) */
  httpStatus: z.number().nullable(),
  models: z.array(z.object({ id: z.string() })),
  truncated: z.boolean(),
  message: z.string().nullable(),
});
export type CustomProviderProbeResponse = z.infer<typeof CustomProviderProbeResponseSchema>;

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
  /**
   * カスタムプロバイダーの定義。管理の正はこちら (アプリ DB の `custom_providers`) で、
   * `providers[]` にも同じ id が `custom: true` で載る (モデル選択の候補が使う)。
   */
  customProviders: z.array(CustomProviderSummarySchema),
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

/** カスタムプロバイダーのモデル入力。上限と正の整数の検証は service が固定文言で行う */
export const CustomProviderModelBodySchema = z.object({
  id: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number().optional(),
});

/** カスタムプロバイダーの作成。id は作成後変更できない。キーは必須で、8..2048 文字 */
export const CreateCustomProviderBodySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: CustomProviderModelBodySchema,
});
export type CreateCustomProviderBody = z.infer<typeof CreateCustomProviderBodySchema>;

/** カスタムプロバイダーの更新。id は変更不可なので body に持たず、apiKey の空欄は既存の維持 */
export const UpdateCustomProviderBodySchema = z.object({
  name: z.string().optional(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  model: CustomProviderModelBodySchema,
});
export type UpdateCustomProviderBody = z.infer<typeof UpdateCustomProviderBodySchema>;

/**
 * モデル一覧の probe。`provider` を渡すと保存済みのキーを使えて (キーは応答に返らない)、
 * `apiKey` が空欄なら保存済みを維持する。どちらも無ければ service が 400 にする。
 */
export const CustomProviderProbeBodySchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
});
export type CustomProviderProbeBody = z.infer<typeof CustomProviderProbeBodySchema>;

/** OAuth サインインの貼り付け (ブラウザの最後の画面の URL / コード)。値は応答にもログにも載せない */
export const SubmitOAuthLoginCodeBodySchema = z.object({
  code: z.string().trim().min(1).max(OAUTH_LOGIN_CODE_MAX_LENGTH),
});
export type SubmitOAuthLoginCodeBody = z.infer<typeof SubmitOAuthLoginCodeBodySchema>;

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

export const ContentBgmSettingsSchema = z.object({
  model: z.string().nullable(),
  format: z.literal("mp3"),
  expectedDurationSeconds: z.literal(30),
});
export type ContentBgmSettings = z.infer<typeof ContentBgmSettingsSchema>;

/**
 * GET /api/settings/content。`configured: false` のとき provider は null（行が無い = 未設定）。
 * APIキーは返さない。`enabled` はアプリ全体の有効 / 無効で、行が無いときは既定 (ON) を返す
 * （`configured` が false ならツールはどちらにせよ公開されない）。
 */
export const ContentSettingsResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  /** キーの暗号文がある (復号できるかは keyAvailable) */
  keyStored: z.boolean(),
  /** キーを復号でき、生成ツールへ渡せる。「設定行がある」「enabled」「keyAvailable」の積が公開ゲート */
  keyAvailable: z.boolean(),
  /** 復号を評価済みか。false は未評価で、失敗とは区別する */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未設定のときは null */
  keyErrorMessage: z.string().nullable(),
  /** 画像・音声・BGM の 3 ツール共通の実行時トグル。行が無ければ true（既定） */
  enabled: z.boolean(),
  /** 画面が同じ文言を出すため、ツールが OFF の間に返す固定文言も応答に載せる */
  disabledMessage: z.string(),
  /** SDK ランタイムの初期化に成功したか。false のときキー登録は 503（model-settings と同じ） */
  runtimeAvailable: z.boolean(),
  image: ContentImageSettingsSchema,
  speech: ContentSpeechSettingsSchema,
  bgm: ContentBgmSettingsSchema,
});
export type ContentSettingsResponse = z.infer<typeof ContentSettingsResponseSchema>;

/** 変更系（PUT / DELETE）の応答。SDK への反映を持たないため `applied` だけを返す */
export const ContentMutationResponseSchema = ContentSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type ContentMutationResponse = z.infer<typeof ContentMutationResponseSchema>;

/** 共有物の状態。値の正は `server/src/app-db.ts` の `SharedContentStatus` */
export const SharedContentStatusSchema = z.enum(["publishing", "published", "stopped", "failed"]);
export type SharedContentStatusValue = z.infer<typeof SharedContentStatusSchema>;

/**
 * 公開元の種類。`session-root` はセッションの作業フォルダ自身 (GUI の `index.html` 行からの入口)、
 * `directory` はその配下のディレクトリ。値の正は `server/src/app-db.ts` の `SharedContentSourceKind`
 */
export const SharedContentSourceKindSchema = z.enum(["directory", "session-root"]);
export type SharedContentSourceKindValue = z.infer<typeof SharedContentSourceKindSchema>;

/** GET /api/shared-contents と GET /api/shared-contents/:id。provider 固有の ID とアカウントは返さない */
export const SharedContentResponseSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  sourcePath: z.string(),
  sourceKind: SharedContentSourceKindSchema,
  provider: z.string(),
  status: SharedContentStatusSchema,
  publicUrl: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  publishedAt: z.number().nullable(),
  stoppedAt: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type SharedContentResponse = z.infer<typeof SharedContentResponseSchema>;

export const SharedContentsResponseSchema = z.object({
  items: z.array(SharedContentResponseSchema),
});
export type SharedContentsResponse = z.infer<typeof SharedContentsResponseSchema>;

/** POST /api/shared-contents。directory はセッションの作業ディレクトリ相対 */
export const CreateSharedContentBodySchema = z.object({
  sessionId: z.string().min(1).max(64),
  directory: z.string().min(1).max(1024),
  name: z.string().max(100).optional(),
});
export type CreateSharedContentBody = z.infer<typeof CreateSharedContentBodySchema>;

/** PATCH /api/shared-contents/:id。表示名だけを変える (URL・状態・成果物は変えない) */
export const RenameSharedContentBodySchema = z.object({
  name: z.string().min(1).max(100),
});
export type RenameSharedContentBody = z.infer<typeof RenameSharedContentBodySchema>;

/** 作成・更新・再試行の受付応答。状態は GET で読む */
export const SharedContentMutationResponseSchema = z.object({
  id: z.string(),
  status: z.literal("publishing"),
});
export type SharedContentMutationResponse = z.infer<typeof SharedContentMutationResponseSchema>;

/** POST /api/shared-contents/:id/stop。停止は同期で確定する (200)。未公開の行は failed を返す */
export const SharedContentStopResponseSchema = z.object({
  id: z.string(),
  status: z.union([z.literal("stopped"), z.literal("failed")]),
});
export type SharedContentStopResponse = z.infer<typeof SharedContentStopResponseSchema>;

/**
 * GET /api/shared-contents/preview。公開前の見え方を返す補助で、確定は公開ジョブの検証。
 * `limited` (413) のときは走査が終わっていないため、件数・サイズ・index.html の有無は `null` にする。
 */
export const SharedContentPreviewResponseSchema = z.object({
  sourcePath: z.string(),
  entries: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  files: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative() })),
  truncated: z.boolean(),
  /** symlink / 特殊ファイル。公開されないことを GUI で説明するために返す */
  links: z.array(z.string()),
  linksTruncated: z.boolean(),
  oversizeFiles: z.array(z.string()),
  oversizeTruncated: z.boolean(),
  hasIndexHtml: z.boolean().nullable(),
  skipped: z.array(z.string()),
  /** 実効の除外名。プレビューと公開が同じ値を使い、対象ディレクトリ自身の名前は落とす */
  excludeNames: z.array(z.string()),
  /** 合計サイズ・件数の上限超過。このとき一覧と index.html の有無は判定しない */
  limited: z.boolean(),
  /** 公開すると失敗する条件。問題なしと言い切らない (秘密値の検査は ZIP を読むまでできない) */
  problems: z.array(z.string()),
});
export type SharedContentPreviewResponse = z.infer<typeof SharedContentPreviewResponseSchema>;

/**
 * GET /api/settings/cloudflare。トークンは返さず、登録状態とアカウント ID だけを返す。
 * `available: false` は master key が使えず、登録・復号が 503 になる状態。
 */
export const CloudflareSettingsResponseSchema = z.object({
  configured: z.boolean(),
  accountId: z.string().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type CloudflareSettingsResponse = z.infer<typeof CloudflareSettingsResponseSchema>;

/**
 * 接続確認の失敗の分類。`CloudflareFailureKind` に、workers.dev サブドメインが空だった場合だけを
 * 接続確認側で足す（`CloudflareFailureKind` 自体は広げない）。
 */
export const CloudflareConnectionFailureSchema = z.enum([
  "unauthorized",
  "not_found",
  "quota",
  "rate_limited",
  "invalid",
  "transient",
  "timeout",
  "network",
  "unverifiable",
  "no_subdomain",
]);
export type CloudflareConnectionFailure = z.infer<typeof CloudflareConnectionFailureSchema>;

/**
 * POST /api/settings/cloudflare/check。保存済みの資格情報で Cloudflare へ届くかを確かめた結果で、
 * 失敗も 200 で返す。成功は `failure === null` かつ `subdomain` が非空、失敗は `subdomain === null`
 * かつ `message` が非 null。`httpStatus` は Cloudflare が返した 400 以上の status だけで、
 * タイムアウト / 通信不能 / 空の subdomain は null。トークンと応答本文は載せない。
 */
export const CloudflareConnectionCheckResponseSchema = z.object({
  checkedAt: z.number(),
  accountId: z.string(),
  subdomain: z.string().nullable(),
  failure: CloudflareConnectionFailureSchema.nullable(),
  httpStatus: z.number().nullable(),
  message: z.string().nullable(),
});
export type CloudflareConnectionCheckResponse = z.infer<typeof CloudflareConnectionCheckResponseSchema>;

/** 変更系 (PUT / DELETE) の応答。何も保存されなかった 503 は `state: "not_stored"` */
export const CloudflareMutationResponseSchema = CloudflareSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type CloudflareMutationResponse = z.infer<typeof CloudflareMutationResponseSchema>;

/**
 * PUT /api/settings/cloudflare。`apiToken` を省略した更新は保存済みトークンを維持する。
 * 形式の検証はサービス側で行い、値そのものは応答・ログへ出さない。
 */
export const UpdateCloudflareSettingsBodySchema = z.object({
  accountId: z.string().min(1).max(64),
  apiToken: z.string().max(512).optional(),
});
export type UpdateCloudflareSettingsBody = z.infer<typeof UpdateCloudflareSettingsBodySchema>;

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

/**
 * PUT /api/settings/content。有効 / 無効の切り替え。キーと選択は保持し、行が無ければ 400（キー登録が先）。
 * 画像・音声・BGM は 1 つのトグルを共有する。
 */
export const UpdateContentEnabledBodySchema = z.object({
  enabled: z.boolean(),
});
export type UpdateContentEnabledBody = z.infer<typeof UpdateContentEnabledBodySchema>;

/**
 * POST /api/settings/content/speech/preview の本文（お試し再生）。モデルと声は画面で選んだ値をそのまま送り、
 * 演技指示と速度は任意。未対応のモデルでは provider が無視するか 400 を返す（対応表はアプリに持たない）。
 */
export const SpeechPreviewBodySchema = z.object({
  model: z.string(),
  /** 空文字は「指定なし」（宣言が無いモデル）で、本文から `voice` を落とす */
  voice: z.string(),
  text: z.string(),
  instructions: z.string().optional(),
  speed: z.number().optional(),
});
export type SpeechPreviewBody = z.infer<typeof SpeechPreviewBodySchema>;

/**
 * お試し再生の失敗応答（音声バイトではない）。`code` は provider の失敗を分類できたときだけ載る。
 * 分類の値は `server/src/provider-failure.ts` の配列を正とし、union を二重定義しない。
 */
export const SpeechPreviewErrorSchema = z.object({
  error: z.string(),
  code: z.enum(PROVIDER_FAILURE_CODES).optional(),
});
export type SpeechPreviewError = z.infer<typeof SpeechPreviewErrorSchema>;

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
  /** プレビュー オリジン (別リスナー) のブラウザから見たポート。待受は別 env */
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
 * 単一ファイルの存在確認 (BFF GET /api/files/stat とサンドボックス GET /v1/files/stat の応答)。
 * path は実在を確認できた通常ファイルの root 相対の正規化パス (root は ".")。本文は含まない。
 */
export const FileStatSchema = z.object({ path: z.string() });
export type FileStat = z.infer<typeof FileStatSchema>;

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
 * サンドボックス GET /v1/skills/file の応答。ワイヤ契約の正は server/src/sandbox/protocol.ts で、
 * ここは BFF が受けた応答の検証用。body は frontmatter を除いた原文 (trim しない)。
 */
export const SandboxSkillFileDetailSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  relativePath: z.string(),
  /** 元ファイルのバイト列の SHA-256。保存はこの値の一致を要求する */
  fileVersion: z.string(),
  /** SKILL.md の mtime (epoch ms)。画面に出す目安で、保存の照合には使わない */
  mtime: z.number(),
  /** false のときは保存できない (reason に理由が入る) */
  editable: z.boolean(),
  reason: z.string().optional(),
});
export type SandboxSkillFileDetail = z.infer<typeof SandboxSkillFileDetailSchema>;

/** サンドボックス POST /v1/skills/file の応答 */
export const SandboxSkillCreateResultSchema = z.object({
  relativePath: z.string(),
  fileVersion: z.string(),
});
export type SandboxSkillCreateResult = z.infer<typeof SandboxSkillCreateResultSchema>;

/** サンドボックス PATCH /v1/skills/file の応答。変更なしの保存も同じ形で現在の版を返す */
export const SandboxSkillSaveResultSchema = z.object({
  relativePath: z.string(),
  fileVersion: z.string(),
});
export type SandboxSkillSaveResult = z.infer<typeof SandboxSkillSaveResultSchema>;

/** サンドボックス GET /v1/skills/file/delete-preview の応答。削除は treeVersion の一致を要求する */
export const SandboxSkillDeletePreviewSchema = z.object({
  relativePath: z.string(),
  name: z.string(),
  /** 削除するフォルダ (root 相対) */
  dir: z.string(),
  treeVersion: z.string(),
  entries: z.number(),
  bytes: z.number(),
  /** 付随ファイルを含む、消えるエントリ (フォルダ相対。ディレクトリは末尾 `/`) */
  files: z.array(z.string()),
});
export type SandboxSkillDeletePreview = z.infer<typeof SandboxSkillDeletePreviewSchema>;

/**
 * サンドボックス POST /v1/skills/import の応答。ワイヤ契約の正は server/src/sandbox/protocol.ts で、
 * ここは BFF が受けた応答の検証用。plan は skills、apply は applied / skipped を返す。
 */
export const SandboxSkillImportPlanEntrySchema = z.object({
  name: z.string(),
  status: z.enum(["new", "identical", "conflict", "invalid"]),
  /** invalid のときだけ入る */
  reason: z.string().optional(),
});
export type SandboxSkillImportPlanEntry = z.infer<typeof SandboxSkillImportPlanEntrySchema>;

export const SandboxSkillsImportPlanSchema = z.object({
  skills: z.array(SandboxSkillImportPlanEntrySchema),
  /** 検証に使った ZIP の総エントリ数 (ディレクトリを含む) */
  entries: z.number().int().nonnegative(),
  /** 検証に使った ZIP の展開後の総バイト数 */
  bytes: z.number().int().nonnegative(),
});
export type SandboxSkillsImportPlan = z.infer<typeof SandboxSkillsImportPlanSchema>;

export const SandboxSkillImportAppliedSchema = z.object({
  name: z.string(),
  /** `.agents/skills/<name>/SKILL.md` (root 相対) */
  relativePath: z.string(),
  /** 取り込んだ SKILL.md のバイト列の SHA-256 */
  fileVersion: z.string(),
  replaced: z.boolean(),
});
export type SandboxSkillImportApplied = z.infer<typeof SandboxSkillImportAppliedSchema>;

export const SandboxSkillImportSkippedSchema = z.object({
  name: z.string(),
  reason: z.string(),
});
export type SandboxSkillImportSkipped = z.infer<typeof SandboxSkillImportSkippedSchema>;

export const SandboxSkillsImportApplySchema = z.object({
  applied: z.array(SandboxSkillImportAppliedSchema),
  skipped: z.array(SandboxSkillImportSkippedSchema),
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type SandboxSkillsImportApply = z.infer<typeof SandboxSkillsImportApplySchema>;

/** 取り込みの応答は mode で形が違う (plan は skills、apply は applied / skipped) */
export const SandboxSkillsImportResultSchema = z.union([SandboxSkillsImportPlanSchema, SandboxSkillsImportApplySchema]);
export type SandboxSkillsImportResult = z.infer<typeof SandboxSkillsImportResultSchema>;

/**
 * POST /api/skills/files の body。名前は GUI 新規の規則 (既存ファイルの保存名の互換とは別) で、
 * 実際の規則の判定はサンドボックス側の SDK 検証が行う。
 */
export const CreateFileSkillBodySchema = z.object({
  name: z.string().min(1).max(SKILL_NAME_MAX),
  description: z.string(),
  body: z.string(),
});
export type CreateFileSkillBody = z.infer<typeof CreateFileSkillBodySchema>;

/** PATCH /api/skills/files の body。name は受け付けず、fileVersion の一致を要求する */
export const SaveFileSkillBodySchema = z.object({
  relativePath: z.string().min(1),
  fileVersion: z.string().min(1),
  description: z.string(),
  body: z.string(),
});
export type SaveFileSkillBody = z.infer<typeof SaveFileSkillBodySchema>;

/**
 * セッションで使えるスキル 1 件 (GET /api/sessions/:id/skills)。設定の FileSkillInfo と違い、
 * プロジェクトスキルを含み、本文は持たない (送信時に取り直す)。
 * 優先順位は project > user > builtin で、負けた行は shadowed / shadowedBy で示す。
 */
export const SessionSkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(["project", "user", "builtin"]),
  /** read に渡せる場所。ファイル / 組み込みとも絶対パス (組み込みは実体の無い仮想パス) */
  location: z.string(),
  /** 表示用の root 相対パス。root の外は null */
  relativePath: z.string().nullable(),
  disableModelInvocation: z.boolean(),
  /**
   * 同名の上位スコープがあり `/skill:` では選ばれない (組み込みで起こり得る)。
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
 * `cwd` は未所属なら "" で、永続化されたセッションのスクラッチ (既定スペースは `.u7agent/sessions/<id>`) とは別の値。
 */
export const SessionSkillsPreviewSchema = SessionSkillsResponseSchema.omit({ sessionId: true });
export type SessionSkillsPreview = z.infer<typeof SessionSkillsPreviewSchema>;

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

// ---------------------------------------------------------------------------
// リクエスト body スキーマ
// route が見るのは JSON の形と型だけ。必須判定と正規化 (trim / 上限 / 未知キー) は catalog が正
// ---------------------------------------------------------------------------

export const PostMessageBodySchema = z.object({
  /** 通常の送信は必須。`resendRunId` を指定した再送では本文を送らず、サーバーが保存済みの本文を使う */
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
 * 会話の分岐。`agentId` の省略は親のスナップショット (エージェント・スキル・ツールの許可) を維持し、
 * 指定時は引き継ぎと同じく現在の定義から作り直す。対象の会話とスペースは path / query で決まる。
 */
export const ForkSessionBodySchema = z.object({
  agentId: z.string().min(1).optional(),
});
export type ForkSessionBody = z.infer<typeof ForkSessionBodySchema>;

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

/**
 * 実行状況から全スペース横断で起動する。会話の所属スペースは問わない (全体管理の面) ため、
 * `/api/serve/start` と違って `?spaceId` との一致を要求しない。
 */
export const RuntimeServeStartBodySchema = z.object({
  sessionId: z.string().min(1),
  generation: z.string().nullable().optional(),
});
export type RuntimeServeStartBody = z.infer<typeof RuntimeServeStartBodySchema>;

/**
 * 設定 → ランタイム のデバッグ一覧。行はレンジ走査で見付かった待受だけで、lease の無い行 (追跡外) は
 * `owner` / `command` / `startedAt` を null にする。`owner` は会話ストアに起動元が残っていて、待受ソケットが
 * lease と一致するときだけ載る (削除済み / 追跡外 / 待受の入れ替わりは null = 所有者不明)。
 */
export const RuntimeDebugServeEntrySchema = z.object({
  port: z.number().int(),
  owner: z.object({ sessionId: z.string(), title: z.string(), spaceId: z.string().optional() }).nullable(),
  command: z.string().nullable(),
  /** 待受プロセスの起動時刻 (epoch ms)。追跡外は null */
  startedAt: z.number().nullable(),
});
export type RuntimeDebugServeEntry = z.infer<typeof RuntimeDebugServeEntrySchema>;

export const RuntimeDebugServeStatusSchema = z.object({ servers: z.array(RuntimeDebugServeEntrySchema) });
export type RuntimeDebugServeStatus = z.infer<typeof RuntimeDebugServeStatusSchema>;

/** 停止対象はレンジ内のポートだけ (対象は常に「いまそのポートで待受している PID」で、世代照合は持たない) */
export const RuntimeDebugServeStopBodySchema = z.object({ port: z.number().int() }).strict();
export type RuntimeDebugServeStopBody = z.infer<typeof RuntimeDebugServeStopBodySchema>;

/** `alreadyStopped` は「そのポートに待受が無い」を表し、成功として返す */
export const RuntimeDebugServeStopResultSchema = z.object({
  port: z.number().int().nullable(),
  released: z.boolean(),
  alreadyStopped: z.boolean(),
});
export type RuntimeDebugServeStopResult = z.infer<typeof RuntimeDebugServeStopResultSchema>;

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

/** 値の表示 / 変更フォーム用。`value` は変数のときだけ入り、シークレットでは省略される */
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

/**
 * 並べ替えで受ける id の上限。形と上限だけを見る点は `ReorderAgentsBodySchema` と同じで、
 * 未知の id・重複の扱いと cwd の照合は `SecretService.reorder` が正。
 */
export const SECRET_ORDER_IDS_MAX = 500;

export const ReorderSecretsBodySchema = z.object({
  ...secretScopeShape,
  ids: z.array(z.string()).max(SECRET_ORDER_IDS_MAX),
});
export type ReorderSecretsBody = z.infer<typeof ReorderSecretsBodySchema>;

/** 通知設定の更新。キー省略は現在値の維持、webhookUrl / baseUrl の null は解除 */
export const UpdateNotificationsBodySchema = z.object({
  enabled: z.boolean().optional(),
  askUser: z.boolean().optional(),
  webhookUrl: z.string().nullish(),
  baseUrl: z.string().nullish(),
});
export type UpdateNotificationsBody = z.infer<typeof UpdateNotificationsBodySchema>;

/** アーカイブ除外名の更新。一覧は丸ごと差し替える（空配列は「除外なし」を表す） */
export const UpdateArchiveSettingsBodySchema = z.object({ excludeNames: z.array(z.string()) });
export type UpdateArchiveSettingsBody = z.infer<typeof UpdateArchiveSettingsBodySchema>;

/** 共有の除外名の更新。同じく丸ごと差し替える */
export const UpdateSharedContentExclusionsBodySchema = z.object({ excludeNames: z.array(z.string()) });
export type UpdateSharedContentExclusionsBody = z.infer<typeof UpdateSharedContentExclusionsBodySchema>;

// 全キー任意にするのは、空 body の PATCH を no-op として通し、必須判定を catalog の文言のまま残すため。
// null は「指定解除」、キー省略は「現在値の維持」で、どちらも catalog が解釈する。
const agentBodyShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  /**
   * 撤去済みの DB カタログ割り当て。**形は受けるが値は catalog が拒否する** (400)。
   * ここで `z.never()` にすると「キーが存在すること」を route が説明できず、
   * 別の理由の 400 と区別できない。
   */
  skillIds: z.unknown().optional(),
  commonSkillNames: z.array(z.string().max(SKILL_NAME_MAX)).max(SKILL_NAMES_MAX).nullish(),
  builtinSkillNames: z.array(z.string().max(SKILL_NAME_MAX)).max(SKILL_NAMES_MAX).nullish(),
  /**
   * スコープ別の自然文発火。省略は現在値の維持、`null` は既定 (発火する) への解除で、2 キーは独立。
   */
  allowNaturalInvocationBuiltin: z.boolean().nullish(),
  allowNaturalInvocationFile: z.boolean().nullish(),
  /**
   * 分割前の 1 本のフラグ。**形だけ受けて catalog が 400 にする** (未知キーとして黙って落とすと、
   * 旧クライアントの保存が成功したように見える)。値の解釈は DB 移行と旧 meta の読み取りだけが行う。
   */
  allowNaturalInvocation: z.boolean().nullish(),
  toolNames: z.array(z.string().max(TOOL_NAME_MAX)).max(TOOL_NAMES_MAX).nullish(),
  icon: z.string().nullish(),
  model: ModelRefSchema.nullish(),
  thinkingLevel: ThinkingLevelSchema.nullish(),
  /**
   * 参照するマスタの ID (並び = 表示順)。未指定は現状維持、`[]` は全解除。
   * 未知・重複・上限超過は保存前に 400 で断り、部分保存しない。
   */
  promptIds: z.array(z.string().max(PROMPT_ID_MAX)).max(AGENT_PROMPT_LIMIT).nullish(),
  /**
   * 撤去済みの直接書き込み。**形は受けるが値は catalog が拒否する** (400)。
   * 黙って捨てると保存できたと誤認させるため、`skillIds` と同じ扱いにする。
   */
  suggestions: z.unknown().optional(),
};

export const CreateAgentBodySchema = z.object(agentBodyShape);
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

export const UpdateAgentBodySchema = z.object(agentBodyShape);
export type UpdateAgentBody = z.infer<typeof UpdateAgentBodySchema>;

/**
 * マスタの作成 / 更新。種別と ID はサーバーが決める。**形は受けるが catalog が拒否する** (400)
 * (`suggestions` と同じ理由で、route が「キーがある」ことを説明できる形にする)。
 * **作成は両項目が必須**で、省略・空文字は保存前に 400 にする (更新の「省略は保持」と混ぜない)。
 */
const promptManagedKeys = {
  id: z.unknown().optional(),
  kind: z.unknown().optional(),
};

export const CreatePromptBodySchema = z.object({
  label: z.string().max(PROMPT_LABEL_MAX),
  prompt: z.string().max(PROMPT_TEXT_MAX),
  ...promptManagedKeys,
});
export type CreatePromptBody = z.infer<typeof CreatePromptBodySchema>;

export const UpdatePromptBodySchema = z.object({
  label: z.string().max(PROMPT_LABEL_MAX).optional(),
  prompt: z.string().max(PROMPT_TEXT_MAX).optional(),
  ...promptManagedKeys,
});
export type UpdatePromptBody = z.infer<typeof UpdatePromptBodySchema>;

/**
 * 並べ替えで受ける id の上限。全件を 1 回で渡す API なので、他の配列項目と同じく
 * 中身の正しさ (存在・重複) はカタログ側が正で、ここは形と上限だけを見る。
 */
export const AGENT_ORDER_IDS_MAX = 200;

export const ReorderAgentsBodySchema = z.object({ ids: z.array(z.string()).max(AGENT_ORDER_IDS_MAX) });
export type ReorderAgentsBody = z.infer<typeof ReorderAgentsBodySchema>;

/**
 * スペースの並べ替えで受ける id の上限。形と上限だけを見る点は `ReorderAgentsBodySchema` と同じで、
 * 未知の id・重複・既定スペースの扱いは `SpaceStore.reorder` が正。
 */
export const SPACE_ORDER_IDS_MAX = 200;

export const ReorderSpacesBodySchema = z.object({ ids: z.array(z.string()).max(SPACE_ORDER_IDS_MAX) });
export type ReorderSpacesBody = z.infer<typeof ReorderSpacesBodySchema>;

// ---------------------------------------------------------------------------
// SSE イベント (sessions.ts の emit 呼び出しを正とする)
// ---------------------------------------------------------------------------

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
  status: z.object({ state: z.string(), text: z.string() }),
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
  /** APIキーの暗号文がある。keyless は常に false */
  keyStored: z.boolean(),
  /** キーを復号でき、検索に使える。keyless は常に true */
  keyAvailable: z.boolean(),
  /** 復号を評価済みか。keyless は常に true */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未保存のときは null */
  keyErrorMessage: z.string().nullable(),
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

/**
 * テスト検索の入力。空白だけは 400 にし、上限は GUI の入力欄に合わせる
 * (チャットの `web_search` は provider 側の上限に任せていて、こことは独立)。
 */
export const WEB_SEARCH_TEST_QUERY_MAX_LENGTH = 500;

export const WebSearchTestBodySchema = z.object({
  query: z.string().trim().min(1).max(WEB_SEARCH_TEST_QUERY_MAX_LENGTH),
});
export type WebSearchTestBody = z.infer<typeof WebSearchTestBodySchema>;

/** テスト検索が実際に送った provider。解決できなかった / 無効のときは null */
export const WebSearchTestProviderSchema = z.object({
  id: WebSearchProviderIdSchema,
  name: z.string(),
  host: z.string(),
});
export type WebSearchTestProvider = z.infer<typeof WebSearchTestProviderSchema>;

/**
 * テスト検索の応答。`output` は成功ならモデルへ返る本文、失敗なら throw する文言 (どちらもマスク済み) で、
 * 画面はそのまま出す。失敗も 200 で返し、保存状態は変えない (会話タイトルの動作確認と同じ契約)。
 */
export const WebSearchTestResponseSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  provider: WebSearchTestProviderSchema.nullable(),
  /** 出典の件数。失敗時は 0 */
  resultCount: z.number(),
  durationMs: z.number(),
});
export type WebSearchTestResponse = z.infer<typeof WebSearchTestResponseSchema>;

/** 変更系の失敗応答（何も変わっていない） */
export const WebSearchMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type WebSearchMutationError = z.infer<typeof WebSearchMutationErrorSchema>;

/**
 * GET / PUT `/api/settings/session-title`。会話タイトルの AI 要約 (On/Off・要約モデル・Effort・定義) を持つ。
 * 行が無い = 既定 (Off・モデル未選択・Effort 未指定・既定の定義)。モデルは本会話のモデルと独立で、
 * `provider/id` で表す。Effort はモデルが対応する段階だけを保存できる。
 */
export const TitleSummaryModelChoiceSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  /** そのモデルが選べる Effort。推論非対応は ["off"] */
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type TitleSummaryModelChoice = z.infer<typeof TitleSummaryModelChoiceSchema>;

export const TitleSummarySettingsResponseSchema = z.object({
  enabled: z.boolean(),
  /** 選択中のモデル (`provider/id`)。未選択は null */
  model: z.string().nullable(),
  /** 保存済みの Effort。null は未指定 (実効値は effectiveThinkingLevel) */
  thinkingLevel: ThinkingLevelSchema.nullable(),
  /** 実際の要約に使う Effort。未指定ならモデルの最小段階、モデル不在なら null */
  effectiveThinkingLevel: ThinkingLevelSchema.nullable(),
  definition: z.string(),
  /** 既定の定義 (画面の「既定に戻す」が使う) */
  defaultDefinition: z.string(),
  /** 認証済みで選択できるモデル。候補が無ければ空 */
  models: z.array(TitleSummaryModelChoiceSchema),
  /** 保存済みモデルが現在の候補に無い。true の間は要約だけを飛ばし、会話の送信は止めない */
  modelAvailable: z.boolean(),
});
export type TitleSummarySettingsResponse = z.infer<typeof TitleSummarySettingsResponseSchema>;

/**
 * 4 項目をまとめて保存する。省略した項目は保存値を保つ (Off から On への切替でモデルを消さない)。
 * thinkingLevel は null で未指定へ戻せる。モデルを変えて Effort を省略した場合、新しいモデルが
 * 対応しない保存値は未指定へ戻す。
 */
export const UpdateTitleSummaryBodySchema = z.object({
  enabled: z.boolean(),
  model: z.string().nullable().optional(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  definition: z.string().optional(),
});
export type UpdateTitleSummaryBody = z.infer<typeof UpdateTitleSummaryBodySchema>;
