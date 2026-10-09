import type { Context } from "hono";
import type { ContentSettingsService, ContentMutationOutcome } from "../content-settings";
import type { UpdateContentImageBody, UpdateContentSpeechBody } from "../schema";

/**
 * 設定 → コンテンツ生成の provider / model / APIキー API。GET は純粋読取、
 * 変更系（PUT / DELETE）は 200 の応答に必ず `state: "applied"` を載せ、
 * DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
 */
export function createContentSettingsRoutes({ contentSettings }: { contentSettings: ContentSettingsService }) {
  return {
    list: (c: Context) => c.json(contentSettings.settings()),

    putSelection: async (c: Context, body: UpdateContentImageBody) =>
      respond(c, await contentSettings.putSelection(body)),

    putSpeechSelection: async (c: Context, body: UpdateContentSpeechBody) =>
      respond(c, await contentSettings.putSpeechSelection(body)),

    putKey: async (c: Context, apiKey: string) => respond(c, await contentSettings.putKey(apiKey)),

    deleteKey: async (c: Context) => respond(c, await contentSettings.deleteKey()),

    // 取得できなくても 200。一覧を失わせず、失敗は catalogError だけに載せる（DB のガードも通さない）
    refreshCatalog: async (c: Context) => c.json(await contentSettings.refreshCatalog()),

    refreshSpeechCatalog: async (c: Context) => c.json(await contentSettings.refreshSpeechCatalog()),
  };
}

function respond(c: Context, outcome: ContentMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}
