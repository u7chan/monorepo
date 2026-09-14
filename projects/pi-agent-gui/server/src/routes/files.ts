import type { Context } from "hono";
import { sandboxFailure, sandboxNotConfigured } from "../http";
import { FileListingSchema } from "../schema";
import type { SandboxWorkspaceClient } from "../sandbox/client";

/** セッションに依存させない (セッションが無くても開ける必要がある) ため、トップレベルのルートにする。 */
export function createFileRoutes({ workspace }: { workspace: SandboxWorkspaceClient | null }) {
  return {
    list: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      const path = c.req.query("path") ?? ".";
      let listing: unknown;
      try {
        listing = await workspace.listFiles(path);
      } catch (error) {
        return sandboxFailure(c, error);
      }
      const parsed = FileListingSchema.safeParse(listing);
      if (!parsed.success) {
        return c.json({ error: "サンドボックスのファイル一覧が不正です" }, 502);
      }
      return c.json(parsed.data);
    },
  };
}
