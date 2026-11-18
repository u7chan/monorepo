/** 共有コンテンツ (公開 / 停止 / サムネイル) の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

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
/**
 * 共有物のサムネイルのメタデータ。実体 (PNG) は `GET /api/shared-contents/:id/thumbnail` で別に取る。
 * `updatedAt` はキャッシュの版で、`?v=<updatedAt>` として URL に載せる。
 */
export const SharedContentThumbnailSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});
export type SharedContentThumbnail = z.infer<typeof SharedContentThumbnailSchema>;
/** PUT /api/shared-contents/:id/thumbnail の応答。差し替えた行のメタをその場で返す */
export const SharedContentThumbnailResponseSchema = z.object({
  thumbnail: SharedContentThumbnailSchema,
});
export type SharedContentThumbnailResponse = z.infer<typeof SharedContentThumbnailResponseSchema>;
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
  /** 未設定は null。公開状態とは独立で、公開の操作を妨げない */
  thumbnail: SharedContentThumbnailSchema.nullable(),
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
