/** スペースとプロジェクトの DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

export const SpaceSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.number() });
export type Space = z.infer<typeof SpaceSchema>;
export const CreateSpaceBodySchema = z.object({ name: z.string().trim().min(1).max(80) });
/** PATCH /api/spaces/:id。入力の規則は作成と同じ (重複名は許可し、同一性は id が持つ) */
export const RenameSpaceBodySchema = CreateSpaceBodySchema;
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
export const CreateProjectBodySchema = z.object({
  cwd: z.string(),
  name: z.string().optional(),
  create: z.boolean().optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
/**
 * スペースの並べ替えで受ける id の上限。形と上限だけを見る点は `ReorderAgentsBodySchema` と同じで、
 * 未知の id・重複・既定スペースの扱いは `SpaceStore.reorder` が正。
 */
export const SPACE_ORDER_IDS_MAX = 200;
export const ReorderSpacesBodySchema = z.object({ ids: z.array(z.string()).max(SPACE_ORDER_IDS_MAX) });

// ---------------------------------------------------------------------------
// SSE イベント (sessions.ts の emit 呼び出しを正とする)
// ---------------------------------------------------------------------------
