import type { Context } from "hono";
import type { TitleSummaryMutationOutcome, TitleSummarySettingsService } from "../title-summary-settings";
import type { TitleSummaryTest } from "../title-summary";
import type { UpdateTitleSummaryBody } from "../schema";

/**
 * 設定 → 会話タイトルの設定 API。変更系の 400 は入力の誤り (理由をそのまま返す)、503 は
 * アプリ DB へ保存できなかったことを表す (コンテンツ生成 / Web 検索と同じ契約)。
 */
export function createTitleSummaryRoutes({
  titleSummarySettings,
  test,
}: {
  titleSummarySettings: TitleSummarySettingsService;
  test: TitleSummaryTest | null;
}) {
  return {
    list: (c: Context) => c.json(titleSummarySettings.settings()),

    put: async (c: Context, body: UpdateTitleSummaryBody) => respond(c, await titleSummarySettings.put(body)),

    /**
     * 保存済みの設定で 1 回だけ生成する。生成の失敗も 200 の `ok: false` で返し、
     * 画面が理由をそのまま出せるようにする (設定の保存状態は変えない)。
     */
    test: async (c: Context) => {
      if (!test) return c.json({ ok: false, error: "AI要約を利用できません", durationMs: 0 }, 503);
      return c.json(await test());
    },
  };
}

function respond(c: Context, outcome: TitleSummaryMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  if (outcome.status === 400) return c.json({ error: outcome.error }, 400);
  return c.json(outcome.response, 200);
}
