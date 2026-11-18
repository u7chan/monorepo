/** バックアップ (書き出し / 復元 / 全削除) の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import { ModelRefSchema, ThinkingLevelSchema } from "./common";

/**
 * バックアップ ZIP の形式。`app` / `schema` が違うものは移行せず 400 にする (docs/backup.md)。
 * 形式の読み書きと検証は `server/src/backup/format.ts` が持ち、ここは境界の型だけを定義する。
 */
export const BACKUP_APP = "u7agent";
export const BACKUP_SCHEMA_VERSION = 1;
/** JSON 3 本 (manifest / prompts / agents) の合計上限。ZIP 全体の上限とは別に持つ */
export const BACKUP_JSON_MAX_BYTES = 16 * 1024 * 1024;
/** バックアップ ZIP のトップレベルエントリ名。manifest.targets と実エントリを完全一致させる */
export const BACKUP_MANIFEST_ENTRY = "manifest.json";
export const BACKUP_PROMPTS_FILE_ENTRY = "prompts.json";
export const BACKUP_AGENTS_FILE_ENTRY = "agents.json";
export const BACKUP_SKILLS_ENTRY = "skills.zip";
/** 復元で受ける対象。manifest の `targets` と query の `targets` はこの語彙だけを使う */
export const BackupTargetSchema = z.enum(["prompts", "agents", "skills"]);
export type BackupTarget = z.infer<typeof BackupTargetSchema>;
export const BackupManifestSchema = z
  .object({
    app: z.string(),
    schema: z.number().int(),
    /** 書き出した時刻 (ISO 8601)。同一判定には使わない (docs/backup.md) */
    exportedAt: z.string(),
    targets: z.array(BackupTargetSchema),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
/** 自作の定型プロンプト 1 件。並びが表示順で、ID はそのまま復元先の主キーになる */
export const BackupPromptSchema = z.object({ id: z.string(), label: z.string(), prompt: z.string() }).strict();
export type BackupPrompt = z.infer<typeof BackupPromptSchema>;
/**
 * ユーザー定義エージェント 1 件。API の `AgentDef` と違い、解決済みの `prompts` ではなく
 * `promptIds` を持つ (本文は `prompts.json` に 1 回だけ書く)。
 */
export const BackupAgentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string(),
    icon: z.string().optional(),
    model: ModelRefSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    commonSkillNames: z.array(z.string()).optional(),
    builtinSkillNames: z.array(z.string()).optional(),
    allowNaturalInvocationBuiltin: z.boolean().optional(),
    allowNaturalInvocationFile: z.boolean().optional(),
    toolNames: z.array(z.string()).optional(),
    promptIds: z.array(z.string()).optional(),
  })
  .strict();
export type BackupAgent = z.infer<typeof BackupAgentSchema>;
export const BackupPromptsFileSchema = z.object({ prompts: z.array(BackupPromptSchema) }).strict();
export type BackupPromptsFile = z.infer<typeof BackupPromptsFileSchema>;
export const BackupAgentsFileSchema = z.object({ agents: z.array(BackupAgentSchema) }).strict();
export type BackupAgentsFile = z.infer<typeof BackupAgentsFileSchema>;
/** 警告とブロッカーのコード。日本語の文言は `client/src/lib/backup.ts` が持つ */
export const BackupWarningSchema = z.object({ code: z.string(), name: z.string().optional() });
export type BackupWarning = z.infer<typeof BackupWarningSchema>;
export const BackupBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  names: z.array(z.string()),
});
export type BackupBlocker = z.infer<typeof BackupBlockerSchema>;
export const BackupDiffStatusSchema = z.enum([
  "added",
  "updated",
  "identical",
  "removed",
  "reordered",
  /** 取り込めない行 (スキルの invalid など)。件数には数えず、ブロッカーとして扱う */
  "blocked",
]);
export type BackupDiffStatus = z.infer<typeof BackupDiffStatusSchema>;
export const BackupDiffItemSchema = z.object({ id: z.string(), name: z.string(), status: BackupDiffStatusSchema });
export type BackupDiffItem = z.infer<typeof BackupDiffItemSchema>;
/** 差分の件数。`reordered` は内容が同一で並びだけが変わる行を数える */
export const BackupDiffCountsSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  identical: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  reordered: z.number().int().nonnegative(),
});
export type BackupDiffCounts = z.infer<typeof BackupDiffCountsSchema>;
export const BackupTargetPlanSchema = z.object({
  target: BackupTargetSchema,
  counts: BackupDiffCountsSchema,
  /** プレビューに出す行。上限で打ち切ったときは `truncated` が true */
  items: z.array(BackupDiffItemSchema),
  truncated: z.boolean(),
  /** 適用後の件数 */
  total: z.number().int().nonnegative(),
  warnings: z.array(BackupWarningSchema),
  blocker: BackupBlockerSchema.nullable(),
});
export type BackupTargetPlan = z.infer<typeof BackupTargetPlanSchema>;
export const BackupRestorePlanSchema = z.object({
  manifest: BackupManifestSchema,
  /** 実際に置き換える対象 (query で絞った結果) */
  selected: z.array(BackupTargetSchema),
  plans: z.array(BackupTargetPlanSchema),
  /** 選択した全対象に差分が無く、ブロッカーも無い */
  changed: z.boolean(),
  blocked: z.boolean(),
  /** 変更しないもの (文言のコード。日本語はクライアントが持つ) */
  kept: z.array(z.string()),
});
export type BackupRestorePlan = z.infer<typeof BackupRestorePlanSchema>;
export const BackupAppliedSchema = z.object({
  target: BackupTargetSchema,
  counts: BackupDiffCountsSchema,
});
export type BackupApplied = z.infer<typeof BackupAppliedSchema>;
export const BackupFailureSchema = z.object({ target: BackupTargetSchema, message: z.string() });
export type BackupFailure = z.infer<typeof BackupFailureSchema>;
/** apply の結果。DB は 1 トランザクション、スキルは別なので `complete: false` の partial を取り得る */
export const BackupRestoreResultSchema = z.object({
  complete: z.boolean(),
  plan: BackupRestorePlanSchema,
  applied: z.array(BackupAppliedSchema),
  failed: z.array(BackupFailureSchema),
});
export type BackupRestoreResult = z.infer<typeof BackupRestoreResultSchema>;
export const BackupExportTargetSchema = z.object({
  target: BackupTargetSchema,
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** スキルだけが持つ。false のときは `reason` を添える */
  available: z.boolean().optional(),
  reason: z.string().optional(),
});
export type BackupExportTarget = z.infer<typeof BackupExportTargetSchema>;
/** GET /api/backup/export/check。dry-run はせず、復元可否は restore plan で確かめる */
export const BackupExportCheckSchema = z.object({
  targets: z.array(BackupTargetSchema),
  entries: z.array(BackupExportTargetSchema),
  bytes: z.number().int().nonnegative(),
  fileName: z.string(),
});
export type BackupExportCheck = z.infer<typeof BackupExportCheckSchema>;
export const BackupResetResultSchema = z.object({
  complete: z.boolean(),
  agents: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  failed: z.array(BackupFailureSchema),
});
export type BackupResetResult = z.infer<typeof BackupResetResultSchema>;
