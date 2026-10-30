import type { Context } from "hono";
import { messageFor, statusCodeOf } from "../http";
import type { PromptCatalog, PromptUsageConflict } from "../prompts";
import type { CreatePromptBody, ReorderPromptsBody, UpdatePromptBody } from "../schema";

/** 409 の応答に使用先を載せる。画面が「どこで使われているか」をそのまま出せる */
function usedByOf(error: unknown): PromptUsageConflict["usedBy"] {
  const value = (error as Partial<PromptUsageConflict> | null)?.usedBy;
  return Array.isArray(value) ? value : [];
}

/**
 * 定型プロンプトのマスタの CRUD。内容の検証と種別 / 使用中の判定はカタログ (server/src/prompts.ts) が正で、
 * ここは HTTP の形へ写すだけにする。拒否のときはデータを変更しない (docs/api-catalog.md)。
 */
export function createPromptRoutes({ prompts }: { prompts: PromptCatalog }) {
  return {
    list: (c: Context) => c.json({ prompts: prompts.list() }),

    get: (c: Context) => {
      const prompt = prompts.get(c.req.param("id") ?? "");
      if (!prompt) return c.json({ error: "Prompt not found" }, 404);
      return c.json({ prompt });
    },

    create: (c: Context, body: CreatePromptBody) => c.json({ prompt: prompts.create(body) }, 201),

    /** 応答は並べ替え後の一覧。クライアントはこれをそのまま採用する (定義は順序で書き換えない) */
    reorder: (c: Context, body: ReorderPromptsBody) => c.json({ prompts: prompts.reorder(body.ids) }),

    update: (c: Context, body: UpdatePromptBody) => c.json({ prompt: prompts.update(c.req.param("id") ?? "", body) }),

    /** 使用中の削除拒否 (409) だけは使用先を返すため、ここで応答を組む (他は onError の定型に任せる) */
    remove: (c: Context) => {
      try {
        prompts.remove(c.req.param("id") ?? "");
        return c.json({ ok: true });
      } catch (error) {
        if (statusCodeOf(error) !== 409) throw error;
        return c.json({ error: messageFor(error), usedBy: usedByOf(error) }, 409);
      }
    },
  };
}
