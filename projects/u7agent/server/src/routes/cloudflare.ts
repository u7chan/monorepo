import type { Context } from "hono";
import type { CloudflareConnectionService } from "../cloudflare-connection";
import type { CloudflareSettingsService } from "../cloudflare-settings";
import { messageFor, statusCodeOf } from "../http";
import type { UpdateCloudflareSettingsBody } from "../schema";

/**
 * 設定 → 共有 → 接続 の Cloudflare 資格情報 API。GET はアカウント ID と登録状態だけを返し、
 * トークンは応答に載せない。変更系の 503 は `state: "not_stored"` を付ける (既存の設定 API と同じ)。
 * 接続確認は状態を変えず、Cloudflare 側の失敗も 200 の結果として返す。
 */
export function createCloudflareSettingsRoutes({
  cloudflareSettings,
  cloudflareConnection,
}: {
  cloudflareSettings: CloudflareSettingsService;
  cloudflareConnection: CloudflareConnectionService;
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

    // 未登録 (409) / master key 不在・復号不可 (503) は onError に任せ、200 の failure に写さない
    check: async (c: Context) => c.json(await cloudflareConnection.check()),
  };
}

function failure(c: Context, error: unknown) {
  const status = statusCodeOf(error) ?? 500;
  if (status === 503) return c.json({ error: messageFor(error), state: "not_stored" as const }, 503);
  return c.json({ error: messageFor(error) }, status as 400);
}
