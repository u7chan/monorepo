import type { MiddlewareHandler } from "hono";
import { httpError } from "./http";
import type { SessionStore } from "./sessions";
import type { SpaceStore } from "./spaces";

export function sessionSpaceGuard(spaces: SpaceStore, store: SessionStore): MiddlewareHandler {
  return async (c, next) => {
    const spaceId = spaces.require(c.req.query("spaceId"));
    const segment = c.req.path.split("/")[3];
    let id = "";
    try {
      id = decodeURIComponent(segment ?? "");
    } catch {
      throw httpError(404, "Session not found");
    }
    const owner = store.spaceOfId(id);
    if (id && (owner !== undefined || spaceId !== "default") && owner !== spaceId)
      throw httpError(404, "Session not found");
    await next();
  };
}

export function spaceContextGuard(spaces: SpaceStore, store: SessionStore): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const creation = path === "/api/sessions" && c.req.method === "POST";
    const projects = path === "/api/projects" || path.startsWith("/api/projects/");
    const preview = path === "/api/skills/session";
    const secrets = path === "/api/secrets" || path.startsWith("/api/secrets/");
    const serve = ["/api/serve/status", "/api/serve/start", "/api/serve/stop"].includes(path);
    if (!creation && path !== "/api/sessions" && !projects && !preview && !secrets && !serve) {
      await next();
      return;
    }
    let parsed: unknown = {};
    if (creation || ((secrets || serve) && ["POST", "PUT"].includes(c.req.method))) {
      try {
        parsed = await c.req.json();
      } catch {
        throw httpError(400, "Request body must be valid JSON");
      }
    }
    const body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const spaceId = spaces.require(creation ? body.spaceId : c.req.query("spaceId"));
    const projectId = body.projectId ?? c.req.query("projectId");
    if (spaceId !== "default" && ((projects && c.req.method !== "GET") || projectId !== undefined)) {
      throw httpError(400, "追加スペースではプロジェクトを利用できません");
    }
    const sessionId = body.sessionId ?? c.req.query("sessionId");
    if (
      secrets &&
      typeof sessionId === "string" &&
      sessionId.trim() &&
      typeof projectId === "string" &&
      projectId.trim()
    )
      throw httpError(400, "sessionId と projectId はどちらか一方だけ指定できます");
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    const owner = store.spaceOfId(id);
    if ((secrets || serve) && id && (owner !== undefined || spaceId !== "default") && owner !== spaceId) {
      throw httpError(404, "Session not found");
    }
    await next();
  };
}
