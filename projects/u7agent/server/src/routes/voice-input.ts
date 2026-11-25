import type { Context } from "hono";
import { readRawBody, respondSettingsMutation, statusCodeOf } from "../http";
import type { VoiceInputSessionFailure } from "../schema";
import {
  VOICE_INPUT_SDP_MAX_BYTES,
  VOICE_INPUT_SESSION_CONTENT_TYPE_MESSAGE,
  VOICE_INPUT_SESSION_EXPIRED_MESSAGE,
  VOICE_INPUT_SESSION_INVALID_OFFER_MESSAGE,
  VOICE_INPUT_SESSION_TOO_LARGE_MESSAGE,
  parseOffer,
  withinDeadline,
  type VoiceInputSessionService,
} from "../voice-input-session";
import type { VoiceInputSettingsService, VoiceInputTestOutcome } from "../voice-input";

/**
 * 音声入力の API。設定（キーは write-only）と Realtime セッションの中継を持ち、鍵の値・暗号文・
 * 上流の本文はどの応答にも載せない。契約は docs/api-settings.md を正とする。
 */
export function createVoiceInputRoutes({
  voiceInputSettings,
  voiceInputSession,
}: {
  voiceInputSettings: VoiceInputSettingsService;
  voiceInputSession: VoiceInputSessionService;
}) {
  return {
    list: (c: Context) => c.json(voiceInputSettings.settings()),

    putKey: async (c: Context, apiKey: string) => respondSettingsMutation(c, await voiceInputSettings.putKey(apiKey)),

    deleteKey: async (c: Context) => respondSettingsMutation(c, await voiceInputSettings.deleteKey()),

    /**
     * 課金なしの疎通確認。上流の確認失敗だけを 200 の `ok: false` で返し、
     * 未登録 / 利用不可は HTTP エラー（409 / 503）にする。結果は保存しない。
     */
    test: async (c: Context) => respondTest(c, await voiceInputSettings.test()),

    /**
     * Realtime セッションの中継。offer SDP を raw のまま受け、answer SDP をそのまま返す。
     * 入口の拒否（415 / 413 / 400 / 408）では上流を呼ばず、成功だけ SDP を返す。
     */
    session: async (c: Context): Promise<Response> => {
      const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/sdp") {
        return c.json({ error: VOICE_INPUT_SESSION_CONTENT_TYPE_MESSAGE }, 415);
      }
      // 本文の読取も含めて 1 本の予算で数える（上流の段はこの残り時間で切る）
      const deadlineAt = Date.now() + voiceInputSession.totalBudgetMs;
      let bytes: Uint8Array;
      try {
        bytes = await withinDeadline(
          readRawBody(c.req.raw, VOICE_INPUT_SDP_MAX_BYTES, VOICE_INPUT_SESSION_TOO_LARGE_MESSAGE),
          deadlineAt,
        );
      } catch (error) {
        // 実受信バイトの上限超過だけを 413 にし、期限切れと読取の中断は 408 に寄せる
        if (statusCodeOf(error) === 413) {
          return c.json({ error: VOICE_INPUT_SESSION_TOO_LARGE_MESSAGE }, 413);
        }
        return c.json({ error: VOICE_INPUT_SESSION_EXPIRED_MESSAGE }, 408);
      }
      const offer = parseOffer(bytes);
      if (offer === null) return c.json({ error: VOICE_INPUT_SESSION_INVALID_OFFER_MESSAGE }, 400);
      if (Date.now() >= deadlineAt) return c.json({ error: VOICE_INPUT_SESSION_EXPIRED_MESSAGE }, 408);
      const outcome = await voiceInputSession.createSession({ offer, deadlineAt, signal: c.req.raw.signal });
      if (outcome.status === 200) {
        // 上流のヘッダは透過せず、この 2 つだけを付ける（answer は末尾の CRLF まで改変しない）
        return c.body(outcome.sdp, 200, { "Content-Type": "application/sdp", "Cache-Control": "no-store" });
      }
      const body: VoiceInputSessionFailure =
        outcome.status === 502 ? { error: outcome.error, code: outcome.code } : { error: outcome.error };
      return c.json(body, outcome.status);
    },
  };
}

function respondTest(c: Context, outcome: VoiceInputTestOutcome) {
  if (outcome.status === 200) return c.json(outcome.response, 200);
  return c.json({ error: outcome.error }, outcome.status);
}
