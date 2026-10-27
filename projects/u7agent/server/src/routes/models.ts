import type { Context } from "hono";
import { messageFor, statusCodeOf } from "../http";
import type { CustomProviderOutcome, ModelSettingsService, MutationOutcome } from "../model-settings";
import type { OAuthLoginOutcome, OAuthLoginService } from "../oauth-login";
import type {
  CreateCustomProviderBody,
  CustomProviderProbeBody,
  UpdateCustomProviderBody,
  UpdateModelAvailabilityBody,
} from "../schema";

/**
 * 設定 → モデルのプロバイダー認証・利用可能なモデルの API。
 * GET は純粋読取、変更系 (PUT / DELETE / resync) は 200 の応答に必ず `state` を載せ、
 * DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
 * OAuth サインインはアプリ DB に何も書かないため `state` を持たず、GET と同じ形で現在の state を返す。
 */
export function createModelSettingsRoutes({
  modelSettings,
  oauthLogin,
}: {
  modelSettings: ModelSettingsService;
  oauthLogin: OAuthLoginService;
}) {
  /** OAuth の操作の結果を GET と同じ DTO で返す。失敗は `{ error }` だけ (DB へは何も書いていない) */
  const oauthResponse = async (c: Context, run: () => Promise<OAuthLoginOutcome>) => {
    const outcome = await run();
    if (outcome.status === 503) return c.json({ error: outcome.error }, 503);
    return c.json(modelSettings.settings(), 200);
  };
  /**
   * 変更系の応答。DB に何も保存されなかったときだけ 503 `{ error, state: "not_stored" }` を返す。
   * サービスは DB 確定前の失敗を戻り値で返すが、事前の DB 読取は httpError(503) を投げるため、
   * ここで同じ形へ揃える (`app.ts` の共通 onError に `not_stored` の補完を期待しない)。
   */
  const mutation = async (c: Context, run: () => Promise<MutationOutcome | CustomProviderOutcome>) => {
    let outcome: MutationOutcome | CustomProviderOutcome;
    try {
      outcome = await run();
    } catch (error) {
      if (statusCodeOf(error) !== 503) throw error;
      return c.json({ error: messageFor(error), state: "not_stored" as const }, 503);
    }
    if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
    return c.json(outcome.response, 200);
  };
  return {
    list: (c: Context) => c.json(modelSettings.settings()),

    /** 利用可能なモデルとアプリ既定モデルの一括保存。両方 null は「未設定へ戻す」 */
    putAllowed: (c: Context, body: UpdateModelAvailabilityBody) =>
      mutation(c, () => modelSettings.putModelSelection(body)),

    putKey: (c: Context, apiKey: string) =>
      mutation(c, () => modelSettings.putKey(c.req.param("provider") ?? "", apiKey)),

    /** provider に紐づく人間用メモ。SDK に触れないため応答は常に applied (長さは route の zod が見る) */
    putMemo: (c: Context, memo: string) =>
      mutation(c, () => modelSettings.putMemo(c.req.param("provider") ?? "", memo)),

    deleteKey: (c: Context) => mutation(c, () => modelSettings.deleteKey(c.req.param("provider") ?? "")),

    /** body なし。DB の希望状態を SDK へ再適用するだけで、冪等。カスタム provider も対象にする */
    resync: (c: Context) => mutation(c, () => modelSettings.resync(c.req.param("provider") ?? "")),

    /**
     * カスタムプロバイダー。定義と暗号化したAPIキーをアプリ DB へ保存してから SDK へ写す。
     * DB 確定前の失敗は 503 `not_stored`、DB 確定後の反映失敗は 200 `applied_unsynced`。
     */
    createCustomProvider: (c: Context, body: CreateCustomProviderBody) =>
      mutation(c, () =>
        modelSettings.createCustomProvider({
          id: body.id,
          name: body.name,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          model: body.model,
        }),
      ),

    updateCustomProvider: (c: Context, body: UpdateCustomProviderBody) =>
      mutation(c, () =>
        modelSettings.updateCustomProvider(c.req.param("provider") ?? "", {
          name: body.name,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          model: body.model,
        }),
      ),

    deleteCustomProvider: (c: Context) =>
      mutation(c, () => modelSettings.deleteCustomProvider(c.req.param("provider") ?? "")),

    /**
     * モデル一覧の probe。状態を変えないので `state` を持たず、接続できない場合も 200 の分類で返す。
     */
    probeCustomProvider: async (c: Context, body: CustomProviderProbeBody) => {
      const response = await modelSettings.probeCustomProvider({
        ...(body.provider === undefined ? {} : { provider: body.provider }),
        baseUrl: body.baseUrl,
        ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
      });
      return c.json(response, 200);
    },

    /**
     * OAuth サインインの開始 (`Sign in with ChatGPT` など)。進行中の二重開始は 409。
     * 認可 URL は応答の provider.login にだけ載り、終端すると落ちる。
     */
    startOAuthLogin: (c: Context) => oauthResponse(c, () => oauthLogin.start(c.req.param("provider") ?? "")),

    /** ブラウザの最後に表示されたリダイレクト先 URL / コードを、待機中の SDK へ渡す */
    submitOAuthLoginCode: (c: Context, code: string) =>
      oauthResponse(c, () => oauthLogin.submitCode(c.req.param("provider") ?? "", code)),

    /** 進行中のサインインの中断と、終端した結果表示の消去 (どちらも冪等) */
    cancelOAuthLogin: (c: Context) => oauthResponse(c, () => oauthLogin.cancel(c.req.param("provider") ?? "")),

    /** サインアウト。auth.json の OAuth を消すだけで、この画面で登録したキーは残す */
    logoutOAuth: (c: Context) => oauthResponse(c, () => oauthLogin.logout(c.req.param("provider") ?? "")),

    /**
     * pi.dev のカタログを取り直す。取得できなくても 200 で現在の一覧を返し、失敗は `catalogError` にだけ載せる
     * (一覧そのものを返せないときだけ、GET /api/runtime/models と同じ 503)。
     */
    catalogRefresh: async (c: Context) => {
      const outcome = await modelSettings.refreshCatalog();
      if (outcome.status === 503) return c.json({ error: outcome.error }, 503);
      return c.json(outcome.response, 200);
    },
  };
}
