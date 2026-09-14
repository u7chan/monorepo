import type { Context } from "hono";
import { messageFor, sandboxFailure, sandboxNotConfigured } from "../http";
import { normalizeProjectCwd } from "../projects";
import type { ProjectStore } from "../projects";
import type { SandboxWorkspaceClient } from "../sandbox/client";
import type { CreateProjectBody } from "../schema";
import type { SessionStore } from "../sessions";

export function createProjectRoutes({
  projects,
  store,
  workspace,
}: {
  projects: ProjectStore;
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
}) {
  return {
    list: (c: Context) => c.json({ projects: projects.list() }),

    create: async (c: Context, body: CreateProjectBody) => {
      let cwd: string;
      try {
        cwd = normalizeProjectCwd(body.cwd);
      } catch (error) {
        return c.json({ error: messageFor(error) }, 400);
      }
      // 重複はサンドボックスへ触る前に弾く (作成要求で既存ディレクトリを触らない)
      if (projects.findByCwd(cwd)) {
        return c.json({ error: `Project already exists: ${cwd}` }, 409);
      }
      if (!workspace) return sandboxNotConfigured(c);
      try {
        // create 省略時は一覧取得で「実在するディレクトリ」を確認する (ディレクトリ以外では失敗する)
        if (body.create) await workspace.createDir(cwd);
        else await workspace.listFiles(cwd);
      } catch (error) {
        return sandboxFailure(c, error);
      }
      return c.json({ project: projects.create({ cwd, name: body.name }) }, 201);
    },

    remove: async (c: Context) => {
      const id = c.req.param("id") ?? "";
      if (!projects.get(id)) return c.json({ error: "Project not found" }, 404);
      // 先に登録を外し、破棄中の並行作成で孤児セッションを作らない (ディレクトリは触らない)
      projects.remove(id);
      await store.destroyByProject(id);
      return c.json({ ok: true });
    },
  };
}
