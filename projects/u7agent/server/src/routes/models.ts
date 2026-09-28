import type { Context } from "hono";
import type { ModelSettingsService } from "../model-settings";
import type { UpdateModelAvailabilityBody } from "../schema";

/**
 * 設定 → モデルのプロバイダー認証・利用可能なモデルの API。
 * GET は純粋読取、変更系 (PUT / DELETE / resync) は 200 の応答に必ず `state` を載せ、
 * DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
 */
export function createModelSettingsRoutes({ modelSettings }: { modelSettings: ModelSettingsService }) {
  return {
    list: (c: Context) => c.json(modelSettings.settings()),

    /** 利用可能なモデルとアプリ既定モデルの一括保存。両方 null は「未設定へ戻す」 */
    putAllowed: async (c: Context, body: UpdateModelAvailabilityBody) => {
      const outcome = await modelSettings.putModelSelection(body);
      if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
      return c.json(outcome.response, 200);
    },

    putKey: async (c: Context, apiKey: string) => {
      const outcome = await modelSettings.putKey(c.req.param("provider") ?? "", apiKey);
      if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
      return c.json(outcome.response, 200);
    },

    /** provider に紐づく人間用メモ。SDK に触れないため応答は常に applied (長さは route の zod が見る) */
    putMemo: async (c: Context, memo: string) => {
      const outcome = await modelSettings.putMemo(c.req.param("provider") ?? "", memo);
      if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
      return c.json(outcome.response, 200);
    },

    deleteKey: async (c: Context) => {
      const outcome = await modelSettings.deleteKey(c.req.param("provider") ?? "");
      if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
      return c.json(outcome.response, 200);
    },

    /** body なし。DB の希望状態を SDK へ再適用するだけで、冪等 */
    resync: async (c: Context) => {
      const outcome = await modelSettings.resync(c.req.param("provider") ?? "");
      if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
      return c.json(outcome.response, 200);
    },
  };
}
