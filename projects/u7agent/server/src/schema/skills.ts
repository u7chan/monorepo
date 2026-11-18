/** ファイルスキル / 会話スキル / 取り込み (plan / apply) の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";
import { SKILL_NAME_MAX } from "./common";

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
