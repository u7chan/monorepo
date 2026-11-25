/** 環境変数 (シークレット) の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import type { SecretKind } from "../secret-crypto";
import { z } from "zod";

/** 種別。型の正は secret-crypto.ts の SecretKind で、ここは同じ値であることを satisfies で固定する */
export const SecretKindSchema = z.enum(["variable", "secret"] satisfies readonly [SecretKind, ...SecretKind[]]);
/** 一覧 / 変更後に行が返す項目。値は種別に関係なく含めない (値は detail の変数だけ) */
export const SecretItemSchema = z.object({
  secretId: z.string(),
  name: z.string(),
  kind: SecretKindSchema,
  /** epoch ms */
  updatedAt: z.number(),
  /** Git の identity を差し替える予約名。gitConfig 付きの bash では子プロセスへ渡らない */
  ignoredByGit: z.boolean(),
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
