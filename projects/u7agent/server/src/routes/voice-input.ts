import type { Context } from "hono";
import type { VoiceInputMutationOutcome, VoiceInputSettingsService, VoiceInputTestOutcome } from "../voice-input";

/**
 * 設定 → 音声入力の設定 API。キーは write-only で、応答は GET と同じ形 + `state` だけを返す
 * （鍵の値・暗号文・上流の本文はどの応答にも載せない）。契約は docs/api-settings.md を正とする。
 */
export function createVoiceInputSettingsRoutes({
  voiceInputSettings,
}: {
  voiceInputSettings: VoiceInputSettingsService;
}) {
  return {
    list: (c: Context) => c.json(voiceInputSettings.settings()),

    putKey: async (c: Context, apiKey: string) => respond(c, await voiceInputSettings.putKey(apiKey)),

    deleteKey: async (c: Context) => respond(c, await voiceInputSettings.deleteKey()),

    /**
     * 課金なしの疎通確認。上流の確認失敗だけを 200 の `ok: false` で返し、
     * 未登録 / 利用不可は HTTP エラー（409 / 503）にする。結果は保存しない。
     */
    test: async (c: Context) => respondTest(c, await voiceInputSettings.test()),
  };
}

function respond(c: Context, outcome: VoiceInputMutationOutcome) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  return c.json(outcome.response, 200);
}

function respondTest(c: Context, outcome: VoiceInputTestOutcome) {
  if (outcome.status === 200) return c.json(outcome.response, 200);
  return c.json({ error: outcome.error }, outcome.status);
}
