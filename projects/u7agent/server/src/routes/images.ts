import type { Context } from "hono";
import type { ImageSettingsService, ImageMutationOutcome } from "../image-settings";
import type { UpdateImageSelectionBody } from "../schema";

/**
 * 設定 → モデル（画像生成）の provider / model / APIキー API。GET は純粋読取、
 * 変更系（PUT / DELETE）は 200 の応答に必ず `state: "applied"` を載せ、
 * DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
 */
export function createImageSettingsRoutes({ imageSettings }: { imageSettings: ImageSettingsService }) {
  return {
    list: (c: Context) => c.json(imageSettings.settings()),

    putSelection: async (c: Context, body: UpdateImageSelectionBody) =>
      respond(c, await imageSettings.putSelection(body)),

    putKey: async (c: Context, apiKey: string) => respond(c, await imageSettings.putKey(apiKey)),

    deleteKey: async (c: Context) => respond(c, await imageSettings.deleteKey()),
  };
}

function respond(c: Context, outcome: ImageMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}
