import type { Context } from "hono";
import type { ContentSettingsService, ContentMutationOutcome, SpeechPreviewOutcome } from "../content-settings";
import type {
  SpeechPreviewBody,
  UpdateContentEnabledBody,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../schema";

/**
 * 設定 → コンテンツ生成の provider / model / APIキー / 有効無効 API。GET は純粋読取、
 * 変更系（PUT / DELETE）は 200 の応答に必ず `state: "applied"` を載せ、
 * DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
 * お試し再生は設定を変えないため、応答は音声バイトか `{ error, code? }` になる。
 */
export function createContentSettingsRoutes({ contentSettings }: { contentSettings: ContentSettingsService }) {
  return {
    list: (c: Context) => c.json(contentSettings.settings()),

    // トグルは画像・音声・BGM で共通（行の enabled 1 列）。サブリソースは provider / model / キーだけにする
    putEnabled: async (c: Context, body: UpdateContentEnabledBody) =>
      respond(c, await contentSettings.putEnabled(body.enabled)),

    putSelection: async (c: Context, body: UpdateContentImageBody) =>
      respond(c, await contentSettings.putSelection(body)),

    putSpeechSelection: async (c: Context, body: UpdateContentSpeechBody) =>
      respond(c, await contentSettings.putSpeechSelection(body)),

    putKey: async (c: Context, apiKey: string) => respond(c, await contentSettings.putKey(apiKey)),

    deleteKey: async (c: Context) => respond(c, await contentSettings.deleteKey()),

    // 課金と待ち時間の所有者はサービス側。route は 1 回呼び、中断だけを渡す
    previewSpeech: async (c: Context, body: SpeechPreviewBody) =>
      respondPreview(c, await contentSettings.previewSpeech(body, { signal: c.req.raw.signal })),

    // 取得できなくても 200。一覧を失わせず、失敗は catalogError だけに載せる（DB のガードも通さない）
    refreshCatalog: async (c: Context) => c.json(await contentSettings.refreshCatalog()),

    refreshSpeechCatalog: async (c: Context) => c.json(await contentSettings.refreshSpeechCatalog()),
  };
}

function respond(c: Context, outcome: ContentMutationOutcome) {
  if (outcome.status === 400) return c.json({ error: outcome.error }, 400);
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}

/** お試し再生は音声バイトを返す。失敗（JSON）との判別は status と Content-Type で行う */
function respondPreview(c: Context, outcome: SpeechPreviewOutcome) {
  if (outcome.status !== 200) {
    return c.json({ error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) }, outcome.status);
  }
  return new Response(outcome.audio, {
    status: 200,
    headers: {
      "Content-Type": outcome.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
