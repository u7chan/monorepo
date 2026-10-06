import type { Context } from "hono";
import type { WebSearchMutationOutcome, WebSearchSettingsService } from "../web-search-settings";
import type { UpdateWebSearchBody } from "../schema";

/**
 * 設定 → モデル（Web 検索）の実行時トグル API。画面が「保存されていない」を区別できるよう、
 * 変更系の 503 には `state: "not_stored"` を付ける（画像生成と同じ契約）。
 */
export function createWebSearchSettingsRoutes({ webSearchSettings }: { webSearchSettings: WebSearchSettingsService }) {
  return {
    list: (c: Context) => c.json(webSearchSettings.settings()),

    put: async (c: Context, body: UpdateWebSearchBody) => respond(c, await webSearchSettings.put(body)),
  };
}

function respond(c: Context, outcome: WebSearchMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}
