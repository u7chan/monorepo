import type { Context } from "hono";
import type { GitSettingsMutationOutcome, GitSettingsService } from "../git-settings";
import type { UpdateGitSettingsBody } from "../schema";

/**
 * 設定 → Git の identity API。PUT / DELETE は app.ts で same-origin の要求だけに絞る
 * (認証ではない defense-in-depth。docs/sandbox.md)。
 */
export function createGitSettingsRoutes({ gitSettings }: { gitSettings: GitSettingsService }) {
  return {
    list: (c: Context) => c.json(gitSettings.settings()),
    put: async (c: Context, body: UpdateGitSettingsBody) => respond(c, await gitSettings.put(body)),
    clear: async (c: Context) => respond(c, await gitSettings.clear()),
  };
}

function respond(c: Context, outcome: GitSettingsMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  if (outcome.status === 400) return c.json({ error: outcome.error }, 400);
  return c.json(outcome.response, 200);
}
