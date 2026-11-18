/** ヘルス / 実行環境 / serve の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import type {
  SandboxGitConfigStatus,
  SandboxLandlockStatus,
  SandboxRuntimeCommand,
  SandboxRuntimeEnvironment,
} from "../sandbox/protocol";
import { z } from "zod";
import { ThinkingLevelSchema } from "./common";
import { ModelOptionSchema, RuntimeVersionsSchema } from "./settings";

/** 作業ディレクトリ単位の serve 成功実績。一覧の会話と稼働記録の両方がこの形で cwd とコマンドを持つ */
export const ServeCommandSchema = z.object({
  /** ワークスペース root 相対の作業ディレクトリ */
  cwd: z.string(),
  command: z.string(),
});
export type ServeCommand = z.infer<typeof ServeCommandSchema>;
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
  /** 旧 sandbox は返さない。BFF は空配列として読み、capability の不一致を diagnostics に出す */
  capabilities: z.array(z.string()).optional(),
  /** 旧 sandbox は返さない。null は「アプリの global config を管理していない」 */
  gitConfig: z
    .object({
      state: z.enum(["ready", "failed"]),
      path: z.string(),
      reason: z.enum(["home_unavailable", "inside_workspace", "symlink", "write_failed"]).optional(),
      ownershipWarnings: z.array(z.object({ cwd: z.string() })).optional(),
    })
    .optional(),
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
      /** サンドボックスが実装している機能。旧版は空で、BFF が git-config-v1 の不一致を警告する */
      capabilities: string[];
      /** アプリの global gitconfig の状態。旧版は null */
      gitConfig: SandboxGitConfigStatus | null;
    }
  | { state: Exclude<RuntimeEnvironmentState, "connected"> };
/** クライアントへ配るため、ワイヤ契約の共通項目も schema 経由で再 export する */
export type { SandboxGitConfigStatus, SandboxLandlockStatus, SandboxRuntimeCommand, SandboxRuntimeEnvironment };
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
  /** ブラウザから見たアプリのオリジン (env `PI_APP_ORIGIN`)。未設定はキー自体を返さない */
  appOrigin: z.string().optional(),
  /** ブラウザから見たプレビュー オリジン (env `PI_FILE_PREVIEW_ORIGIN`)。未設定はキー自体を返さない */
  filePreviewOrigin: z.string().optional(),
  /** ブラウザから見たサービス オリジン (env `PI_PREVIEW_ORIGIN`)。未設定はキー自体を返さない */
  serviceOrigin: z.string().optional(),
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
