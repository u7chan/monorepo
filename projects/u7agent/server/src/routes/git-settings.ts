import type { Context } from "hono";
import type { GitSettingsService } from "../git-settings";
import { respondSettingsMutation } from "../http";
import type { UpdateGitSettingsBody } from "../schema";

/**
 * 設定 → Git の identity API。PUT / DELETE は app.ts で same-origin の要求だけに絞る
 * (認証ではない defense-in-depth。docs/sandbox.md)。
 */
export function createGitSettingsRoutes({ gitSettings }: { gitSettings: GitSettingsService }) {
  return {
    list: (c: Context) => c.json(gitSettings.settings()),
    put: async (c: Context, body: UpdateGitSettingsBody) => respondSettingsMutation(c, await gitSettings.put(body)),
    clear: async (c: Context) => respondSettingsMutation(c, await gitSettings.clear()),
  };
}
