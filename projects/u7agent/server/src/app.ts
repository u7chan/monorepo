import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import type { AppDb } from "./app-db";
import { createBffContext } from "./bootstrap";
import type { CreateBffAppOptions } from "./bootstrap";
import { bodyGuard, jsonBodyValidator, messageFor, statusCodeOf } from "./http";
import { createCatalogRoutes } from "./routes/catalog";
import { createFileRoutes } from "./routes/files";
import { createHealthRoutes } from "./routes/health";
import { createProjectRoutes } from "./routes/projects";
import { createSessionRoutes } from "./routes/sessions";
import { DEFAULT_CLIENT_DIST_DIR, serveClientAssets } from "./static";
import {
  CreateAgentBodySchema,
  CreateProjectBodySchema,
  CreateSessionBodySchema,
  CreateSkillBodySchema,
  PostMessageBodySchema,
  RenameFileBodySchema,
  UpdateAgentBodySchema,
  UpdateSessionSettingsBodySchema,
  UpdateSkillBodySchema,
} from "./schema";

// client は本ファイルを型ソースとして参照するため DTO 型を再配布する
export * from "./schema";
export type { CreateBffAppOptions };

/**
 * アプリデータ (SQLite) を読む API の入口。開けていないときは 503 にして、空のカタログや未所属へ
 * 黙って落とさない (会話ストアの storeError と同じ規約)。
 */
function appDataGuard(appDb: AppDb): MiddlewareHandler {
  return async (c, next) => {
    if (!appDb.status().ok) {
      // 一過性の失敗から戻れるように、失敗状態のときだけ軽く読み直す (成功したら解除される)
      try {
        appDb.probe();
      } catch {
        const { error } = appDb.status();
        return c.json({ error: `アプリデータ（SQLite）を利用できません: ${error ?? "unknown error"}` }, 503);
      }
    }
    await next();
  };
}

export async function createBffApp(opts: CreateBffAppOptions = {}) {
  const { clientDistDir = DEFAULT_CLIENT_DIST_DIR } = opts;
  const { cwd, pi, initError, catalog, projects, store, workspace, sessionStore, appDb } = await createBffContext(opts);
  const appData = appDataGuard(appDb);

  const healthRoutes = createHealthRoutes({ pi, initError, cwd, store, appDb });
  const fileRoutes = createFileRoutes({ workspace });
  const catalogRoutes = createCatalogRoutes({ catalog, workspace, rootCwd: cwd });
  const projectRoutes = createProjectRoutes({ projects, store, workspace });
  const sessionRoutes = createSessionRoutes({ store, workspace });

  const app = new Hono()
    // bodyGuard は本文を最長 64 KiB で読み切って text 化するため、raw で受けるアップロードは先に登録する
    .post("/api/sessions/:id/files", (c) => sessionRoutes.uploadFile(c))
    .use("/api/*", bodyGuard)
    .get("/api/health", healthRoutes.health)
    .get("/api/files", fileRoutes.list)
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
    .get("/api/skills", appData, catalogRoutes.listSkills)
    .get("/api/skills/files", catalogRoutes.listFileSkills)
    // セッション未確定 (新規チャット) の一覧。GET /api/skills/:id は無いので静的セグメントで衝突しない
    .get("/api/skills/session", appData, sessionRoutes.previewSkills)
    .post(
      "/api/skills",
      appData,
      jsonBodyValidator(CreateSkillBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.createSkill(c, c.req.valid("json")),
    )
    .patch(
      "/api/skills/:id",
      appData,
      jsonBodyValidator(UpdateSkillBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.updateSkill(c, c.req.valid("json")),
    )
    .put(
      "/api/skills/:id",
      appData,
      jsonBodyValidator(UpdateSkillBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => catalogRoutes.updateSkill(c, c.req.valid("json")),
    )
    .delete("/api/skills/:id", appData, catalogRoutes.removeSkill)
    .get("/api/sessions", appData, sessionRoutes.list)
    .post(
      "/api/sessions",
      appData,
      zValidator("json", CreateSessionBodySchema, (result, c) =>
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
    .get("/api/sessions/:id", appData, sessionRoutes.get)
    .delete("/api/sessions/:id", sessionRoutes.remove)
    .post("/api/sessions/:id/stop", sessionRoutes.stop)
    .post("/api/sessions/:id/abort", sessionRoutes.stop)
    .get("/api/sessions/:id/skills", sessionRoutes.skills)
    .post(
      "/api/sessions/:id/messages",
      appData,
      zValidator("json", PostMessageBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "text is required" }, 400),
      ),
      (c) => sessionRoutes.postMessage(c, c.req.valid("json")),
    )
    .get("/api/sessions/:id/events", appData, sessionRoutes.events)
    // Hono は登録順にマッチするため、未マッチの GET を拾う catch-all は最後に置く。
    .get("*", serveClientAssets(clientDistDir))
    .notFound((c) => c.json({ error: "Not found" }, 404))
    .onError((error, c) => {
      // hono validator の JSON パース失敗 (HTTPException 400) は契約の文言に寄せる
      if (error instanceof HTTPException && error.status === 400) {
        return c.json({ error: "Request body must be valid JSON" }, 400);
      }
      return c.json({ error: messageFor(error) }, (statusCodeOf(error) ?? 500) as ContentfulStatusCode);
    });

  return {
    app,
    store,
    catalog,
    projects,
    pi,
    initError,
    sessionStore,
    appDb,
    close: async () => {
      await store.close();
      appDb.close();
    },
  };
}

export type AppType = Awaited<ReturnType<typeof createBffApp>>["app"];
