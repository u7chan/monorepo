import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import { createBffContext } from "./bootstrap";
import type { CreateBffAppOptions } from "./bootstrap";
import { bodyGuard, messageFor, statusCodeOf } from "./http";
import { createCatalogRoutes } from "./routes/catalog";
import { createFileRoutes } from "./routes/files";
import { createHealthRoutes } from "./routes/health";
import { createProjectRoutes } from "./routes/projects";
import { createSessionRoutes } from "./routes/sessions";
import { DEFAULT_CLIENT_DIST_DIR, serveClientAssets } from "./static";
import {
  CreateProjectBodySchema,
  CreateSessionBodySchema,
  PostMessageBodySchema,
  ReplaceCatalogBodySchema,
  UpdateSessionSettingsBodySchema,
} from "./schema";

// client は本ファイルを型ソースとして参照するため DTO 型を再配布する
export * from "./schema";
export type { CreateBffAppOptions };

export async function createBffApp(opts: CreateBffAppOptions = {}) {
  const { clientDistDir = DEFAULT_CLIENT_DIST_DIR } = opts;
  const { cwd, pi, initError, catalog, projects, store, workspace } = await createBffContext(opts);

  const healthRoutes = createHealthRoutes({ pi, initError, cwd });
  const fileRoutes = createFileRoutes({ workspace });
  const catalogRoutes = createCatalogRoutes({ catalog });
  const projectRoutes = createProjectRoutes({ projects, store, workspace });
  const sessionRoutes = createSessionRoutes({ store });

  const app = new Hono()
    .use("/api/*", bodyGuard)
    .get("/api/health", healthRoutes.health)
    .get("/api/files", fileRoutes.list)
    .get("/api/projects", projectRoutes.list)
    .post(
      "/api/projects",
      zValidator("json", CreateProjectBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => projectRoutes.create(c, c.req.valid("json")),
    )
    .delete("/api/projects/:id", projectRoutes.remove)
    .get("/api/agents", catalogRoutes.snapshot)
    .put(
      "/api/agents",
      zValidator("json", ReplaceCatalogBodySchema, (result, c) =>
        result.success
          ? undefined
          : c.json({ error: "Definitions must contain skills and agents arrays" }, 400),
      ),
      (c) => catalogRoutes.replace(c, c.req.valid("json")),
    )
    .post("/api/agents", catalogRoutes.createAgent)
    .patch("/api/agents/:id", catalogRoutes.updateAgent)
    .put("/api/agents/:id", catalogRoutes.updateAgent)
    .delete("/api/agents/:id", catalogRoutes.removeAgent)
    .get("/api/skills", catalogRoutes.listSkills)
    .post("/api/skills", catalogRoutes.createSkill)
    .patch("/api/skills/:id", catalogRoutes.updateSkill)
    .put("/api/skills/:id", catalogRoutes.updateSkill)
    .delete("/api/skills/:id", catalogRoutes.removeSkill)
    .get("/api/sessions", sessionRoutes.list)
    .post(
      "/api/sessions",
      zValidator("json", CreateSessionBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
      ),
      (c) => sessionRoutes.create(c, c.req.valid("json")),
    )
    .patch(
      "/api/sessions/:id/settings",
      zValidator("json", UpdateSessionSettingsBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "Invalid session settings" }, 400),
      ),
      (c) => sessionRoutes.updateSettings(c, c.req.valid("json")),
    )
    .get("/api/sessions/:id", sessionRoutes.get)
    .delete("/api/sessions/:id", sessionRoutes.remove)
    .post("/api/sessions/:id/stop", sessionRoutes.stop)
    .post("/api/sessions/:id/abort", sessionRoutes.stop)
    .post(
      "/api/sessions/:id/messages",
      zValidator("json", PostMessageBodySchema, (result, c) =>
        result.success ? undefined : c.json({ error: "text is required" }, 400),
      ),
      (c) => sessionRoutes.postMessage(c, c.req.valid("json")),
    )
    .get("/api/sessions/:id/events", sessionRoutes.events)
    // Hono は登録順にマッチするため、未マッチの GET を拾う catch-all は最後に置く。
    .get("*", serveClientAssets(clientDistDir))
    .notFound((c) => c.json({ error: "Not found" }, 404))
    .onError((error, c) => {
      // hono validator の JSON パース失敗 (HTTPException 400) は契約の文言に寄せる
      if (error instanceof HTTPException && error.status === 400) {
        return c.json({ error: "Request body must be valid JSON" }, 400);
      }
      return c.json(
        { error: messageFor(error) },
        (statusCodeOf(error) ?? 500) as ContentfulStatusCode,
      );
    });

  return {
    app,
    store,
    catalog,
    projects,
    pi,
    initError,
    close: async () => {
      await store.close();
    },
  };
}

export type AppType = Awaited<ReturnType<typeof createBffApp>>["app"];
