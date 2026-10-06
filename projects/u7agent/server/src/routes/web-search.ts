import type { Context } from "hono";
import type { WebSearchMutationOutcome, WebSearchSettingsService } from "../web-search-settings";
import type { UpdateWebSearchBody, UpdateWebSearchProviderBody } from "../schema";

/**
 * 設定 → モデル（Web 検索）の設定 API。画面が「保存されていない」を区別できるよう、
 * 変更系の 503 には `state: "not_stored"` を付ける（画像生成と同じ契約）。
 */
export function createWebSearchSettingsRoutes({ webSearchSettings }: { webSearchSettings: WebSearchSettingsService }) {
  return {
    list: (c: Context) => c.json(webSearchSettings.settings()),

    putEnabled: async (c: Context, body: UpdateWebSearchBody) =>
      respond(c, await webSearchSettings.putEnabled(body.enabled)),

    putProvider: async (c: Context, body: UpdateWebSearchProviderBody) =>
      respond(c, await webSearchSettings.putProvider(body.provider)),

    putKey: async (c: Context, provider: string, apiKey: string) =>
      respond(c, await webSearchSettings.putKey(provider, apiKey)),

    deleteKey: async (c: Context, provider: string) => respond(c, await webSearchSettings.deleteKey(provider)),
  };
}

function respond(c: Context, outcome: WebSearchMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}
