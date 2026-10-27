import type { Context } from "hono";
import type { UpdateWebSearchBody, UpdateWebSearchProviderBody, WebSearchTestBody } from "../schema";
import { WEB_SEARCH_TEST_UNAVAILABLE_MESSAGE, type WebSearchTest } from "../web-search-test";
import type { WebSearchMutationOutcome, WebSearchSettingsService } from "../web-search-settings";

/**
 * 設定 → Web 検索の設定 API。画面が「保存されていない」を区別できるよう、
 * 変更系の 503 には `state: "not_stored"` を付ける（コンテンツ生成と同じ契約）。
 */
export function createWebSearchSettingsRoutes({
  webSearchSettings,
  test,
}: {
  webSearchSettings: WebSearchSettingsService;
  /** 設定画面のテスト検索。実行環境を作れない起動 (pi なし) は null で 503 */
  test: WebSearchTest | null;
}) {
  return {
    list: (c: Context) => c.json(webSearchSettings.settings()),

    putEnabled: async (c: Context, body: UpdateWebSearchBody) =>
      respond(c, await webSearchSettings.putEnabled(body.enabled)),

    putProvider: async (c: Context, body: UpdateWebSearchProviderBody) =>
      respond(c, await webSearchSettings.putProvider(body.provider)),

    putKey: async (c: Context, provider: string, apiKey: string) =>
      respond(c, await webSearchSettings.putKey(provider, apiKey)),

    deleteKey: async (c: Context, provider: string) => respond(c, await webSearchSettings.deleteKey(provider)),

    /**
     * 保存済みの設定で 1 回だけ検索する。検索の失敗も 200 の `ok: false` で返し、
     * 画面がモデルへ返る文言をそのまま出せるようにする (設定の保存状態は変えない)。
     */
    test: async (c: Context, body: WebSearchTestBody) => {
      if (!test) return c.json({ error: WEB_SEARCH_TEST_UNAVAILABLE_MESSAGE }, 503);
      return c.json(await test(body.query));
    },
  };
}

function respond(c: Context, outcome: WebSearchMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}
