import type { Context } from "hono";
import type { CloudflareSettingsService } from "../cloudflare-settings";
import { messageFor, statusCodeOf } from "../http";
import type { UpdateCloudflareSettingsBody } from "../schema";

/**
 * 設定 → 共有 → 接続 の Cloudflare 資格情報 API。GET はアカウント ID と登録状態だけを返し、
 * トークンは応答に載せない。変更系の 503 は `state: "not_stored"` を付ける (既存の設定 API と同じ)。
 */
export function createCloudflareSettingsRoutes({
  cloudflareSettings,
}: {
  cloudflareSettings: CloudflareSettingsService;
}) {
  return {
    get: (c: Context) => c.json(cloudflareSettings.status()),

    update: async (c: Context, body: UpdateCloudflareSettingsBody) => {
      try {
        return c.json(await cloudflareSettings.save(body));
      } catch (error) {
        return failure(c, error);
      }
    },

    remove: async (c: Context) => {
      try {
        return c.json(await cloudflareSettings.remove());
      } catch (error) {
        return failure(c, error);
      }
    },
  };
}

function failure(c: Context, error: unknown) {
  const status = statusCodeOf(error) ?? 500;
  if (status === 503) return c.json({ error: messageFor(error), state: "not_stored" as const }, 503);
  return c.json({ error: messageFor(error) }, status as 400);
}
