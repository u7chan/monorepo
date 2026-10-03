import type { Context } from "hono";
import { messageFor, statusCodeOf } from "../http";
import type { CreateSecretBody, UpdateSecretBody } from "../schema";
import type { SecretScopeResolver, SecretService } from "../secrets";

/**
 * 作業環境 → 環境変数 の API。要求元は会話 (sessionId) かプロジェクト起点の新規会話 (projectId) で、
 * cwd への解決はサーバー側だけが行う (client は cwd を送らない)。シークレットの値は返さず、
 * 変数の値は変更フォーム用の詳細だけが返す。設計は docs/secrets.md を正とする。
 *
 * クエリの読み取りは handler の本体で `c.req.query("<name>")` を直に呼ぶ (client の hc が要求型を
 * 推論するため。ヘルパーへ渡すとキーが見えず、query を型として受け取れない)。
 */
export function createSecretRoutes({ secrets, scope }: { secrets: SecretService; scope: SecretScopeResolver }) {
  const failure = (c: Context, error: unknown) => {
    const status = statusCodeOf(error) ?? 500;
    // 変更系の 503 (DB / master key) は「何も保存していない」ことも state で示す (既存の契約と同じ)
    if (status === 503) return c.json({ error: messageFor(error), state: "not_stored" as const }, 503);
    return c.json({ error: messageFor(error) }, status as 400);
  };

  return {
    list: async (c: Context) => {
      try {
        const sessionId = c.req.query("sessionId");
        const projectId = c.req.query("projectId");
        return c.json(secrets.list(scope.resolve({ sessionId, projectId })));
      } catch (error) {
        return failure(c, error);
      }
    },

    detail: async (c: Context) => {
      try {
        const sessionId = c.req.query("sessionId");
        const projectId = c.req.query("projectId");
        return c.json(secrets.detail(scope.resolve({ sessionId, projectId }), c.req.param("secretId") ?? ""));
      } catch (error) {
        return failure(c, error);
      }
    },

    create: async (c: Context, body: CreateSecretBody) => {
      try {
        const resolved = scope.resolve({ sessionId: body.sessionId, projectId: body.projectId });
        return c.json(secrets.create(resolved, { kind: body.kind, name: body.name, value: body.value }));
      } catch (error) {
        return failure(c, error);
      }
    },

    update: async (c: Context, body: UpdateSecretBody) => {
      try {
        const resolved = scope.resolve({ sessionId: body.sessionId, projectId: body.projectId });
        return c.json(secrets.updateValue(resolved, c.req.param("secretId") ?? "", body.value));
      } catch (error) {
        return failure(c, error);
      }
    },

    remove: async (c: Context) => {
      try {
        const sessionId = c.req.query("sessionId");
        const projectId = c.req.query("projectId");
        return c.json(secrets.remove(scope.resolve({ sessionId, projectId }), c.req.param("secretId") ?? ""));
      } catch (error) {
        return failure(c, error);
      }
    },
  };
}
