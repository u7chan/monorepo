import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import type { AppDb } from "./app-db";
import { createBffContext } from "./bootstrap";
import type { CreateBffAppOptions } from "./bootstrap";
import { DEFAULT_FILE_PREVIEW_PORT } from "./file-preview-port";
import { bodyGuard, jsonBodyValidator, messageFor, statusCodeOf } from "./http";
import { mutationOriginGuard } from "./mutation-origin";
import { DEFAULT_PREVIEW_PORT } from "./preview-port";
import { createArchiveRoutes } from "./routes/archive";
import { createCatalogRoutes } from "./routes/catalog";
import { createFileRoutes } from "./routes/files";
import { createHealthRoutes } from "./routes/health";
import { createCloudflareSettingsRoutes } from "./routes/cloudflare";
import { createSharedContentRoutes } from "./routes/shared-contents";
import { createSharedContentExclusionsRoutes } from "./routes/shared-content-exclusions";
import { createContentSettingsRoutes } from "./routes/content";
import { createNotificationRoutes } from "./routes/notifications";
import { createModelSettingsRoutes } from "./routes/models";
import { createProjectRoutes } from "./routes/projects";
import { createRuntimeRoutes } from "./routes/runtime";
import { createSecretRoutes } from "./routes/secrets";
import { createServeRoutes } from "./routes/serve";
import { createSkillFileRoutes } from "./routes/skill-files";
import { createSessionRoutes } from "./routes/sessions";
import { createWebSearchSettingsRoutes } from "./routes/web-search";
import { createTitleSummaryRoutes } from "./routes/title-summary";
import { createSecretScope } from "./secrets";
import { createSpaceDelete } from "./space-delete";
import { SpaceStore } from "./spaces";
import { sessionSpaceGuard, spaceContextGuard } from "./space-context";
import { DEFAULT_CLIENT_DIST_DIR, serveClientAssets } from "./static";
import {
  AnswerQuestionBodySchema,
  CreateSharedContentBodySchema,
  RenameSharedContentBodySchema,
  CreateSpaceBodySchema,
  CreateAgentBodySchema,
  CreateCustomProviderBodySchema,
  CustomProviderProbeBodySchema,
  CreateProjectBodySchema,
  CreateSecretBodySchema,
  CreateSessionBodySchema,
  CreateFileSkillBodySchema,
  MoveSessionBodySchema,
  PostMessageBodySchema,
  RenameFileBodySchema,
  ReorderAgentsBodySchema,
  ReorderSecretsBodySchema,
  ReorderSpacesBodySchema,
  SpeechPreviewBodySchema,
  UpdateAgentBodySchema,
  UpdateArchiveSettingsBodySchema,
  UpdateContentEnabledBodySchema,
  UpdateContentImageBodySchema,
  UpdateContentKeyBodySchema,
  UpdateCloudflareSettingsBodySchema,
  UpdateContentSpeechBodySchema,
  UpdateCustomProviderBodySchema,
  UpdateModelAvailabilityBodySchema,
  UpdateNotificationsBodySchema,
  UpdateProviderKeyBodySchema,
  UpdateTitleSummaryBodySchema,
  UpdateWebSearchBodySchema,
  UpdateWebSearchKeyBodySchema,
  UpdateWebSearchProviderBodySchema,
  UpdateProviderMemoBodySchema,
  UpdateSharedContentExclusionsBodySchema,
  SubmitOAuthLoginCodeBodySchema,
  UpdateSecretBodySchema,
  UpdateSessionNotifyBodySchema,
  UpdateSessionPinnedBodySchema,
  UpdateSessionSettingsBodySchema,
  UpdateSessionTitleBodySchema,
  SaveFileSkillBodySchema,
  ServeStartBodySchema,
  ServeStopBodySchema,
  RuntimeDebugServeStopBodySchema,
  RuntimeServeStartBodySchema,
  RuntimeServeStopBodySchema,
} from "./schema";

// client は本ファイルを型ソースとして参照するため DTO 型を再配布する
export * from "./schema";
export type { CreateBffAppOptions };

/**
 * アプリデータ (SQLite) を読む API の入口。開けていないときは 503 にして、空のカタログや未所属へ
 * 黙って落とさない (会話ストアの storeError と同じ規約)。変更系のルートでは、何も変わっていないことを
 * 応答契約 (`{ error, state: "not_stored" }`) でも示す。
 */
function appDataGuard(appDb: AppDb, { notStored = false }: { notStored?: boolean } = {}): MiddlewareHandler {
  return async (c, next) => {
    if (!appDb.status().ok) {
      // 一過性の失敗から戻れるように、失敗状態のときだけ軽く読み直す (成功したら解除される)
      try {
        appDb.probe();
      } catch {
        const { error } = appDb.status();
        const body = { error: `アプリデータ（SQLite）を利用できません: ${error ?? "unknown error"}` };
        return notStored ? c.json({ ...body, state: "not_stored" as const }, 503) : c.json(body, 503);
      }
    }
    await next();
  };
}

export async function createBffApp(opts: CreateBffAppOptions = {}) {
  const {
    clientDistDir = DEFAULT_CLIENT_DIST_DIR,
    filePreviewPort = DEFAULT_FILE_PREVIEW_PORT,
    previewPort = DEFAULT_PREVIEW_PORT,
  } = opts;
  const {
    cwd,
    pi,
    initError,
    catalog,
    projects,
    store,
    workspace,
    sessionStore,
    appDb,
    notifications,
    archiveSettings,
    runtimeDiagnostics,
    modelSettings,
    oauthLogin,
    contentSettings,
    webSearchSettings,
    titleSummarySettings,
    serve,
    secrets,
    cloudflareSettings,
    cloudflareConnection,
    sharedContents,
    sharedContentExclusions,
    skillSandbox,
    skillArchiveSandbox,
  } = await createBffContext(opts);
  const appData = appDataGuard(appDb);
  const spaces = new SpaceStore(appDb);
  // 変更系は「何も保存していない」ことを state でも示す
  const appDataMutation = appDataGuard(appDb, { notStored: true });
  // 削除は会話ストア・ワークスペース・公開サービスの 3 つを跨ぐため、実体をここで組む
  const spaceDelete = createSpaceDelete({ spaces, store, workspace, serve, appDb });

  const healthRoutes = createHealthRoutes({
    pi,
    initError,
    cwd,
    store,
    appDb,
    archiveSettings,
    filePreviewPort,
    previewPort,
  });
  const runtimeRoutes = createRuntimeRoutes({ pi, runtimeDiagnostics });
  const fileRoutes = createFileRoutes({ workspace, archiveSettings, sandbox: "isolated" });
  // プレビュー専用リスナー (別オリジン) 用。storage を有効にするため、応答は HTML プレビューのルートだけにする
  const previewFileRoutes = createFileRoutes({ workspace, archiveSettings, sandbox: "storage" });
  const catalogRoutes = createCatalogRoutes({ catalog, workspace, rootCwd: cwd });
  const skillFileRoutes = createSkillFileRoutes({ sandbox: skillSandbox, archive: skillArchiveSandbox });
  const projectRoutes = createProjectRoutes({ projects, store, workspace });
  const sessionRoutes = createSessionRoutes({ store, workspace, spaces, serve });
  const notificationRoutes = createNotificationRoutes({ notifications });
  const archiveRoutes = createArchiveRoutes({ archiveSettings });
  const modelSettingsRoutes = createModelSettingsRoutes({ modelSettings, oauthLogin });
  const contentSettingsRoutes = createContentSettingsRoutes({ contentSettings });
  const cloudflareSettingsRoutes = createCloudflareSettingsRoutes({ cloudflareSettings, cloudflareConnection });
  const sharedContentRoutes = createSharedContentRoutes({ sharedContents });
  const sharedContentExclusionsRoutes = createSharedContentExclusionsRoutes({ sharedContentExclusions });
  const webSearchSettingsRoutes = createWebSearchSettingsRoutes({ webSearchSettings });
  const titleSummaryRoutes = createTitleSummaryRoutes({ titleSummarySettings });
  // 環境変数の要求元 (sessionId / projectId) を cwd へ解決する唯一の点。client は cwd を送らない
  const secretRoutes = createSecretRoutes({
    secrets,
    scope: createSecretScope({ sessions: store, projects }),
  });
  // serve は実績 (app-db) と稼働判定 (プローブ / サンドボックス) の両方を読むため、
  // アプリデータが使えないときは 503 で止める (空の実績へ黙って落とさない)
  const serveRoutes = createServeRoutes({ serve });

  const app = new Hono()
    .use("/api/*", mutationOriginGuard)
    .use("/api/sessions/*", sessionSpaceGuard(spaces, store))
    // bodyGuard は本文を最長 64 KiB で読み切って text 化するため、raw で受けるアップロードは先に登録する
    .post("/api/sessions/:id/files", (c) => sessionRoutes.uploadFile(c))
    // スキルの取り込みも raw の ZIP を中継する (JSON 化されると展開できない)
    .post("/api/skills/files/import", (c) => skillFileRoutes.import(c))
    .use("/api/*", bodyGuard)
    .use("/api/*", spaceContextGuard(spaces, store))
    .get("/api/spaces", appData, (c) => c.json({ spaces: spaces.list() }))
    .post(
      "/api/spaces",
      appDataMutation,
      jsonBodyValidator(CreateSpaceBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => c.json({ space: spaces.create(c.req.valid("json").name) }, 201),
    )
    // 並べ替え。応答は正規化後の一覧で、これが以後の GET と一致する (docs/api.md#スペース)
    .patch(
      "/api/spaces/order",
      appData,
      jsonBodyValidator(ReorderSpacesBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => c.json({ spaces: spaces.reorder(c.req.valid("json").ids) }),
    )
    // 追加スペースの削除。会話・履歴・作業フォルダ・cwd キーの行まで消す (docs/api.md#スペース)
    .delete("/api/spaces/:id", appDataMutation, async (c) => {
      await spaceDelete.remove(c.req.param("id"));
      return c.json({ ok: true });
    })
    .get("/api/health", healthRoutes.health)
    .get("/api/runtime/models", runtimeRoutes.models)
    .get("/api/runtime/environment", runtimeRoutes.environment)
    .get("/api/files", fileRoutes.list)
    // 存在確認 (本文を取得しない)。一覧と同じ root 相対の path を受ける
    .get("/api/files/stat", fileRoutes.stat)
    // 一覧と同じ root 相対の path を受ける (repo の外は 200 + branch: null)
    .get("/api/files/git", fileRoutes.git)
    // 一覧と同じパスに DELETE を重ねる (パスはクエリで受ける)
    .delete("/api/files", fileRoutes.remove)
    // パスは本文で受ける (改名先の名前をクエリに載せない)
    .post(
      "/api/files/rename",
      jsonBodyValidator(RenameFileBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => fileRoutes.rename(c, c.req.valid("json")),
    )
    .get("/api/files/preview", fileRoutes.preview)
    // `:path{.+}` はルート配下のパスを 1 セグメントで受ける (wildcard `*` は Hono 4 で param として取れない)
    .get("/api/files/html/:path{.+}", fileRoutes.html)
    .get("/api/files/raw", fileRoutes.raw)
    .get("/api/files/download", fileRoutes.download)
    // `download` の下に置く静的パス。`download` 自身と衝突しない
    .get("/api/files/download/check", fileRoutes.downloadCheck)
    .get("/api/projects", appData, projectRoutes.list)
    .post(
      "/api/projects",
      appData,
      zValidator("json", CreateProjectBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => projectRoutes.create(c, c.req.valid("json")),
    )
    .delete("/api/projects/:id", appData, projectRoutes.remove)
    .get("/api/agents", appData, catalogRoutes.snapshot)
    .post(
      "/api/agents",
      appData,
      jsonBodyValidator(CreateAgentBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.createAgent(c, c.req.valid("json")),
    )
    // 静的セグメントは /api/agents/:id より前に置く (後ろだと Hono が `order` を id として拾う)
    .patch(
      "/api/agents/order",
      appData,
      jsonBodyValidator(ReorderAgentsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.reorderAgents(c, c.req.valid("json")),
    )
    .patch(
      "/api/agents/:id",
      appData,
      jsonBodyValidator(UpdateAgentBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.updateAgent(c, c.req.valid("json")),
    )
    .put(
      "/api/agents/:id",
      appData,
      jsonBodyValidator(UpdateAgentBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.updateAgent(c, c.req.valid("json")),
    )
    .delete("/api/agents/:id", appData, catalogRoutes.removeAgent)
    // スキルの一覧・編集はファイル (`.agents/skills`) だけを対象にする。旧 `/api/skills` と
    // `/api/skills/:id` の DB カタログ CRUD は置かず、新しい API へも転送しない (404)
    .get("/api/skills/files", catalogRoutes.listFileSkills)
    .get("/api/skills/files/export", skillFileRoutes.export)
    .get("/api/skills/files/export/check", skillFileRoutes.exportCheck)
    .get("/api/skills/files/detail", skillFileRoutes.detail)
    .get("/api/skills/files/delete-preview", skillFileRoutes.deletePreview)
    .delete("/api/skills/files", skillFileRoutes.remove)
    .post(
      "/api/skills/files",
      jsonBodyValidator(CreateFileSkillBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => skillFileRoutes.create(c, c.req.valid("json")),
    )
    .patch(
      "/api/skills/files",
      jsonBodyValidator(SaveFileSkillBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => skillFileRoutes.save(c, c.req.valid("json")),
    )
    // セッション未確定 (新規チャット) の一覧
    .get("/api/skills/session", appData, sessionRoutes.previewSkills)
    .get("/api/sessions", appData, sessionRoutes.list)
    .post(
      "/api/sessions",
      appData,
      jsonBodyValidator(CreateSessionBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => sessionRoutes.create(c, c.req.valid("json")),
    )
    .patch(
      "/api/sessions/:id/settings",
      appData,
      zValidator("json", UpdateSessionSettingsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid session settings" }, 400),
      ),
      (c) => sessionRoutes.updateSettings(c, c.req.valid("json")),
    )
    // 通知トグルは専用経路。model / thinkingLevel の設定変更と違い、busy でも切り替えられる
    .patch(
      "/api/sessions/:id/notify",
      appData,
      zValidator("json", UpdateSessionNotifyBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "notify is required" }, 400),
      ),
      (c) => sessionRoutes.updateNotify(c, c.req.valid("json")),
    )
    // ピン留めは SDK に触れないため、実行中・未ロードでも meta.json だけを更新できる
    .patch(
      "/api/sessions/:id/pin",
      appData,
      zValidator("json", UpdateSessionPinnedBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "pinned is required" }, 400),
      ),
      (c) => sessionRoutes.updatePinned(c, c.req.valid("json")),
    )
    // タイトルの変更も通知と同じ専用経路 (SDK に触らないため、実行中でも変えられる)
    .patch(
      "/api/sessions/:id/title",
      appData,
      zValidator("json", UpdateSessionTitleBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "title is required" }, 400),
      ),
      (c) => sessionRoutes.updateTitle(c, c.req.valid("json")),
    )
    // セッションの引っ越し。履歴は破棄され、作業フォルダ / 添付 / cwd キーの行が移動先へ移る
    .post(
      "/api/sessions/:id/move",
      appDataMutation,
      zValidator("json", MoveSessionBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "spaceId is required" }, 400),
      ),
      (c) => sessionRoutes.move(c, c.req.valid("json")),
    )
    .get("/api/sessions/:id", appData, sessionRoutes.get)
    // 全履歴のカーソルページ。`:id` より深いパスのため順序に依存しないが、:id の近くに置く
    .get("/api/sessions/:id/history", appData, sessionRoutes.history)
    // 切り分け用のダンプ。SDK に触れず、mask 済みのイベントと状態の要約を返す
    .get("/api/sessions/:id/diagnostics", appData, sessionRoutes.diagnostics)
    // 生ログ (session.jsonl。mask 前) のダウンロード。履歴を持たない会話は 404
    .get("/api/sessions/:id/raw", appData, sessionRoutes.rawLog)
    .delete("/api/sessions/:id", sessionRoutes.remove)
    .post("/api/sessions/:id/stop", sessionRoutes.stop)
    .post("/api/sessions/:id/abort", sessionRoutes.stop)
    // body 無し。手動 compaction は完了まで待って `{ sessionId, status }` を返す
    .post("/api/sessions/:id/compact", sessionRoutes.compact)
    .get("/api/sessions/:id/skills", sessionRoutes.skills)
    .post(
      "/api/sessions/:id/messages",
      appData,
      zValidator("json", PostMessageBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "text is required" }, 400),
      ),
      (c) => sessionRoutes.postMessage(c, c.req.valid("json")),
    )
    // ask_user の回答。body は質問ごとの回答の配列で、省略された質問があれば 400 になる
    .post(
      "/api/sessions/:id/questions/:toolCallId/answer",
      appData,
      zValidator("json", AnswerQuestionBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => sessionRoutes.answerQuestion(c, c.req.valid("json")),
    )
    // 待機キューからの 1 件だけの取り消し (実行は止めず、本文は未送信として残す)
    .delete("/api/sessions/:id/queue/:sendId", appData, sessionRoutes.cancelQueued)
    // 未送信メッセージの破棄 (再送は POST /messages の resendRunId)
    .delete("/api/sessions/:id/unsent/:sendId", appData, sessionRoutes.discardUnsent)
    .get("/api/sessions/:id/events", appData, sessionRoutes.events)
    .get("/api/serve/status", appData, serveRoutes.status)
    .get("/api/serve/runtime/status", appData, serveRoutes.runtimeStatus)
    // デバッグ枠は公開枠とは別の取得にし、失敗しても公開カードを壊さない (一覧は軽い走査だけで組む)
    .get("/api/serve/debug/status", appData, serveRoutes.debugStatus)
    .post(
      "/api/serve/debug/stop",
      appDataMutation,
      jsonBodyValidator(RuntimeDebugServeStopBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => serveRoutes.debugStop(c, c.req.valid("json")),
    )
    .post(
      "/api/serve/runtime/stop",
      appDataMutation,
      jsonBodyValidator(RuntimeServeStopBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => serveRoutes.runtimeStop(c, c.req.valid("json")),
    )
    // 実行状況からの起動。閲覧中の会話に依存せず、別スペースの会話も起動できる (全体管理の面)
    .post(
      "/api/serve/runtime/start",
      appDataMutation,
      jsonBodyValidator(RuntimeServeStartBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => serveRoutes.runtimeStart(c, c.req.valid("json")),
    )
    .post(
      "/api/serve/start",
      // 起動は実績を書き換える変更系なので、503 では何も保存していないことを state でも示す
      appDataMutation,
      jsonBodyValidator(ServeStartBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => serveRoutes.start(c, c.req.valid("json")),
    )
    .post(
      "/api/serve/stop",
      appDataMutation,
      jsonBodyValidator(ServeStopBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => serveRoutes.stop(c, c.req.valid("json")),
    )
    .get("/api/secrets", appData, secretRoutes.list)
    .post(
      "/api/secrets",
      // 登録は行を増やす変更系なので、503 では何も保存していないことを state でも示す
      appDataMutation,
      jsonBodyValidator(CreateSecretBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => secretRoutes.create(c, c.req.valid("json")),
    )
    // 静的セグメントは /api/secrets/:secretId より前に置く
    .patch(
      "/api/secrets/order",
      appDataMutation,
      jsonBodyValidator(ReorderSecretsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => secretRoutes.reorder(c, c.req.valid("json")),
    )
    .get("/api/secrets/:secretId", appData, secretRoutes.detail)
    .put(
      "/api/secrets/:secretId",
      appDataMutation,
      jsonBodyValidator(UpdateSecretBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => secretRoutes.update(c, c.req.valid("json")),
    )
    .delete("/api/secrets/:secretId", appDataMutation, secretRoutes.remove)
    .get("/api/notifications", appData, notificationRoutes.get)
    .put(
      "/api/notifications",
      appData,
      jsonBodyValidator(UpdateNotificationsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => notificationRoutes.update(c, c.req.valid("json")),
    )
    .post("/api/notifications/test", appData, notificationRoutes.test)
    .get("/api/settings/archive", appData, archiveRoutes.get)
    .put(
      "/api/settings/archive",
      appData,
      jsonBodyValidator(UpdateArchiveSettingsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => archiveRoutes.update(c, c.req.valid("json")),
    )
    .delete("/api/settings/archive", appData, archiveRoutes.reset)
    // 共有の除外名。アーカイブの設定とは別の行・別の既定を持つ (docs/static-sharing.md)
    .get("/api/settings/shared-content-exclusions", appData, sharedContentExclusionsRoutes.get)
    .put(
      "/api/settings/shared-content-exclusions",
      appData,
      jsonBodyValidator(UpdateSharedContentExclusionsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => sharedContentExclusionsRoutes.update(c, c.req.valid("json")),
    )
    .delete("/api/settings/shared-content-exclusions", appData, sharedContentExclusionsRoutes.reset)
    .get("/api/settings/models", appData, modelSettingsRoutes.list)
    .put(
      "/api/settings/models/allowed",
      appDataMutation,
      jsonBodyValidator(UpdateModelAvailabilityBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.putAllowed(c, c.req.valid("json")),
    )
    // pi.dev への外向き通信だけで DB に触れないため appData のゲートは通さず、
    // `:provider` より先に置いて静的パスがパラメータへ食われないようにする
    .post("/api/settings/models/catalog/refresh", modelSettingsRoutes.catalogRefresh)
    // カスタムプロバイダー (オンメモリ)。DB を触らないので appDataMutation は通さない。
    // `models/:provider/...` と同じ深さに param ルートを並べると、provider id がパス接頭辞と
    // 同じ既存 provider の API を食うため、別の名前空間に置く
    .post(
      "/api/settings/custom-providers",
      jsonBodyValidator(CreateCustomProviderBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.createCustomProvider(c, c.req.valid("json")),
    )
    // 状態を変えないため state を持たず、接続できない場合も 200 の分類で返す
    .post(
      "/api/settings/custom-providers/probe",
      jsonBodyValidator(CustomProviderProbeBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.probeCustomProvider(c, c.req.valid("json")),
    )
    .put(
      "/api/settings/custom-providers/:provider",
      jsonBodyValidator(UpdateCustomProviderBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.updateCustomProvider(c, c.req.valid("json")),
    )
    .delete("/api/settings/custom-providers/:provider", modelSettingsRoutes.deleteCustomProvider)
    .put(
      "/api/settings/models/:provider/key",
      appDataMutation,
      jsonBodyValidator(UpdateProviderKeyBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.putKey(c, c.req.valid("json").apiKey),
    )
    .delete("/api/settings/models/:provider/key", appDataMutation, modelSettingsRoutes.deleteKey)
    .put(
      "/api/settings/models/:provider/memo",
      appDataMutation,
      jsonBodyValidator(UpdateProviderMemoBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.putMemo(c, c.req.valid("json").memo),
    )
    .post("/api/settings/models/:provider/resync", appDataMutation, modelSettingsRoutes.resync)
    // OAuth サインイン。アプリ DB を触らない (auth.json だけ) ため appData のゲートは通さない
    .post("/api/settings/models/:provider/login", modelSettingsRoutes.startOAuthLogin)
    .post(
      "/api/settings/models/:provider/login/code",
      jsonBodyValidator(SubmitOAuthLoginCodeBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => modelSettingsRoutes.submitOAuthLoginCode(c, c.req.valid("json").code),
    )
    .delete("/api/settings/models/:provider/login", modelSettingsRoutes.cancelOAuthLogin)
    .post("/api/settings/models/:provider/logout", modelSettingsRoutes.logoutOAuth)
    .get("/api/settings/content", appData, contentSettingsRoutes.list)
    .put(
      "/api/settings/content",
      appDataMutation,
      jsonBodyValidator(UpdateContentEnabledBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => contentSettingsRoutes.putEnabled(c, c.req.valid("json")),
    )
    .put(
      "/api/settings/content/image",
      appDataMutation,
      jsonBodyValidator(UpdateContentImageBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => contentSettingsRoutes.putSelection(c, c.req.valid("json")),
    )
    .put(
      "/api/settings/content/key",
      appDataMutation,
      jsonBodyValidator(UpdateContentKeyBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => contentSettingsRoutes.putKey(c, c.req.valid("json").apiKey),
    )
    .put(
      "/api/settings/content/speech",
      appDataMutation,
      jsonBodyValidator(UpdateContentSpeechBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => contentSettingsRoutes.putSpeechSelection(c, c.req.valid("json")),
    )
    // お試し再生は設定を変えないため appDataMutation は使わない（state: "not_stored" を返さない）
    .post(
      "/api/settings/content/speech/preview",
      appData,
      jsonBodyValidator(SpeechPreviewBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => contentSettingsRoutes.previewSpeech(c, c.req.valid("json")),
    )
    .delete("/api/settings/content/key", appDataMutation, contentSettingsRoutes.deleteKey)
    .get("/api/settings/cloudflare", appData, cloudflareSettingsRoutes.get)
    .put(
      "/api/settings/cloudflare",
      appDataMutation,
      jsonBodyValidator(UpdateCloudflareSettingsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => cloudflareSettingsRoutes.update(c, c.req.valid("json")),
    )
    .delete("/api/settings/cloudflare", appDataMutation, cloudflareSettingsRoutes.remove)
    // 接続確認は何も保存しないため appDataMutation を使わない (state: "not_stored" を返さない)
    .post("/api/settings/cloudflare/check", appData, cloudflareSettingsRoutes.check)
    // preview は :id より前に置く (後に置くと id="preview" として 404 になる)
    .get("/api/shared-contents/preview", appData, sharedContentRoutes.preview)
    .get("/api/shared-contents", appData, sharedContentRoutes.list)
    .post(
      "/api/shared-contents",
      appDataMutation,
      jsonBodyValidator(
        CreateSharedContentBodySchema,
        (result, c) =>
          result.success ? undefined : c.json({ error: "Invalid request body", state: "not_stored" as const }, 400),
        {
          invalidJson: (c) => c.json({ error: "Request body must be valid JSON", state: "not_stored" as const }, 400),
        },
      ),
      (c) => sharedContentRoutes.create(c, c.req.valid("json")),
    )
    .get("/api/shared-contents/:id", appData, sharedContentRoutes.detail)
    // 表示名だけの変更。行を保存するので、本文の検証失敗は state: "not_stored" を付ける
    .patch(
      "/api/shared-contents/:id",
      appDataMutation,
      jsonBodyValidator(
        RenameSharedContentBodySchema,
        (result, c) =>
          result.success ? undefined : c.json({ error: "Invalid request body", state: "not_stored" as const }, 400),
        {
          invalidJson: (c) => c.json({ error: "Request body must be valid JSON", state: "not_stored" as const }, 400),
        },
      ),
      (c) => sharedContentRoutes.rename(c, c.req.valid("json")),
    )
    .post("/api/shared-contents/:id/publish", appDataMutation, sharedContentRoutes.publish)
    .post("/api/shared-contents/:id/stop", appDataMutation, sharedContentRoutes.stop)
    .post("/api/shared-contents/:id/resume", appDataMutation, sharedContentRoutes.resume)
    .delete("/api/shared-contents/:id", appDataMutation, sharedContentRoutes.remove)
    .post("/api/settings/content/image/catalog/refresh", (c) => contentSettingsRoutes.refreshCatalog(c))
    .post("/api/settings/content/speech/catalog/refresh", (c) => contentSettingsRoutes.refreshSpeechCatalog(c))
    .get("/api/settings/web-search", appData, webSearchSettingsRoutes.list)
    .put(
      "/api/settings/web-search",
      appDataMutation,
      jsonBodyValidator(UpdateWebSearchBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => webSearchSettingsRoutes.putEnabled(c, c.req.valid("json")),
    )
    .put(
      "/api/settings/web-search/provider",
      appDataMutation,
      jsonBodyValidator(UpdateWebSearchProviderBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => webSearchSettingsRoutes.putProvider(c, c.req.valid("json")),
    )
    .put(
      "/api/settings/web-search/providers/:provider/key",
      appDataMutation,
      jsonBodyValidator(UpdateWebSearchKeyBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      // キー値はマスカー登録のあるサービス側でだけ扱い、パス / クエリへは出さない
      (c) => webSearchSettingsRoutes.putKey(c, c.req.param("provider"), c.req.valid("json").apiKey),
    )
    .delete("/api/settings/web-search/providers/:provider/key", appDataMutation, (c) =>
      webSearchSettingsRoutes.deleteKey(c, c.req.param("provider")),
    )
    .get("/api/settings/session-title", appData, titleSummaryRoutes.list)
    .put(
      "/api/settings/session-title",
      appDataMutation,
      jsonBodyValidator(UpdateTitleSummaryBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => titleSummaryRoutes.put(c, c.req.valid("json")),
    )
    // Hono は登録順にマッチするため、未マッチの GET を拾う catch-all は最後に置く。
    .get("*", serveClientAssets(clientDistDir, filePreviewPort))
    .notFound((c) => c.json({ error: "Not found" }, 404))
    .onError((error, c) => {
      // hono validator の JSON パース失敗 (HTTPException 400) は契約の文言に寄せる
      if (error instanceof HTTPException && error.status === 400) {
        return c.json({ error: "Request body must be valid JSON" }, 400);
      }
      const path = c.req.path;
      if (
        statusCodeOf(error) === 503 &&
        ["POST", "PUT", "DELETE"].includes(c.req.method) &&
        (path === "/api/spaces" ||
          path.startsWith("/api/secrets") ||
          ["/api/serve/start", "/api/serve/stop"].includes(path))
      ) {
        return c.json({ error: messageFor(error), state: "not_stored" as const }, 503);
      }
      return c.json({ error: messageFor(error) }, (statusCodeOf(error) ?? 500) as ContentfulStatusCode);
    });

  // プレビュー専用リスナー (別オリジン)。HTML 文書とその兄弟アセットのルートだけを載せ、
  // 書き込み系 API を置かない (storage を有効にした文書からアプリの面を叩けないようにする)。
  const previewApp = new Hono().get("/api/files/html/:path{.+}", previewFileRoutes.html);

  return {
    app,
    /** 別オリジンで配るプレビュー リスナー (server/src/index.ts が 2 本目の serve() に渡す) */
    previewApp,
    store,
    catalog,
    projects,
    pi,
    initError,
    sessionStore,
    appDb,
    notifications,
    archiveSettings,
    modelSettings,
    oauthLogin,
    contentSettings,
    webSearchSettings,
    titleSummarySettings,
    serve,
    secrets,
    cloudflareSettings,
    cloudflareConnection,
    sharedContents,
    sharedContentExclusions,
    close: async () => {
      // 未完了の送信結果は記録しない (プロセス終了時に破棄する)
      notifications.close();
      await store.close();
      appDb.close();
    },
  };
}

export type AppType = Awaited<ReturnType<typeof createBffApp>>["app"];
