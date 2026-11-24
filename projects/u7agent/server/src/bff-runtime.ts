import { join } from "node:path";
import { CredentialSynchronizationError, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { PiBff } from "./agent";
import { createDeviceIdStore, DEVICE_ID_PATH } from "./device-id";
import { canSignInHere, type OAuthLoginRuntime } from "./oauth-login";
import type { CredentialCommit, ProviderKeyRuntime } from "./model-settings";

/** SDK のログインで名乗る名前。同意画面の `agent_name_hint` に出る静的な文字列で、秘密情報ではない */
export const OAUTH_AGENT_NAME = "u7agent";

/**
 * SDK の ModelRuntime を OAuthLoginRuntime へ写す。`login` の戻り値 (credential) は捨て、保存は SDK に委ねる。
 * device id は agent dir 配下のファイルへ永続化し、プロセスを再起動しても同じ UUID を返す。
 */
export function createOAuthLoginRuntime(pi: PiBff): OAuthLoginRuntime {
  const { modelRuntime } = pi;
  const deviceIds = createDeviceIdStore(join(pi.agentDir, DEVICE_ID_PATH), (message) =>
    console.warn(`[u7agent] ${message}`),
  );
  return {
    list: () =>
      modelRuntime.getProviders().map((provider) => ({
        provider: provider.id,
        supportsOAuth: Boolean(provider.auth?.oauth),
        oauthLoginLabel: provider.auth?.oauth?.loginLabel ?? null,
      })),
    loginOAuth: (provider, interaction) =>
      settleCredentialOperation("login", provider, () =>
        modelRuntime.login(provider, "oauth", interaction, {
          getDeviceId: () => deviceIds.getOrCreate(),
          agentName: OAUTH_AGENT_NAME,
        }),
      ),
    logoutOAuth: (provider, { signal }) =>
      settleCredentialOperation("logout", provider, () => modelRuntime.logout(provider, { signal })),
    credentialKind: (provider) => (modelRuntime.isUsingOAuth(provider) ? "oauth" : null),
    // readStoredCredential は読取に失敗したら undefined を返す。種別以外はここで捨てる
    storedCredentialKind: (provider) => readStoredCredential(provider, join(pi.agentDir, "auth.json"))?.type,
  };
}

/**
 * SDK は auth.json への commit 後に snapshot の同期が失敗しても CSE を投げるため、provider と操作が
 * 一致する CSE だけを「保存済み・反映は次回の再計算で追いつく」として成功に倒す (credential は返さない)。
 */
async function settleCredentialOperation(
  operation: "login" | "logout",
  provider: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (
      error instanceof CredentialSynchronizationError &&
      error.providerId === provider &&
      error.operation === operation
    ) {
      console.warn(`[u7agent] oauth ${operation} credential synced late: ${provider}`);
      return;
    }
    throw error;
  }
}

/**
 * SDK の ModelRuntime を ProviderKeyRuntime へ写す。SDK の例外は throw せず CredentialCommit へ分類し、
 * `credential` / `cause` / 生の例外文言はこの境界から外へ出さない。
 */
export function createProviderKeyRuntime(pi: PiBff): ProviderKeyRuntime {
  const { modelRuntime } = pi;
  // SDK が実際に読む保存先と同じパス。表示専用の覗き見にだけ使う
  const storedAuthPath = join(pi.agentDir, "auth.json");
  return {
    list: () =>
      modelRuntime.getProviders().map((provider) => {
        const supportsOAuth = Boolean(provider.auth?.oauth);
        return {
          provider: provider.id,
          name: provider.name || provider.id,
          // auth.apiKey.login は「対話でキー入力を受け付ける」印。ambient / keyless は login を持たない
          canSetApiKey: Boolean(provider.auth?.apiKey?.login),
          supportsOAuth,
          // 画面がサインインの操作を出せるかの判定。OAuth を求める方式でも、この画面が扱えない対話を
          // 必要とする flow はここで false になる (許可リストは oauth-login 側が持つ)
          canSignInHere: canSignInHere(provider.id, supportsOAuth),
          // OAuth の表示名だけを渡す (ログイン手段の名前で、トークンや client_id ではない)
          oauthLoginLabel: provider.auth?.oauth?.loginLabel ?? null,
        };
      }),
    auth: (provider) => modelRuntime.getProviderAuthStatus(provider),
    credentialKind: (provider) => (modelRuntime.isUsingOAuth(provider) ? "oauth" : "api_key"),
    // readStoredCredential は読取に失敗したら undefined を返す。種別以外はここで捨てる
    storedCredentialKind: (provider) => readStoredCredential(provider, storedAuthPath)?.type,
    // 認証の有無を見ない getModels() を引く (未認証のモデルも許可リストには入れられる)
    catalog: () => modelRuntime.getModels().map((model) => ({ provider: model.provider, id: model.id })),
    refreshCatalog: (options) => pi.refreshModelCatalog(options),
    catalogSnapshot: () => pi.modelCatalog,
    applyApiKey: (provider, apiKey, { signal }) =>
      commitCredential("setRuntimeApiKey", provider, signal, () =>
        modelRuntime.setRuntimeApiKey(provider, apiKey, { signal }),
      ),
    removeApiKey: (provider, { signal }) =>
      commitCredential("removeRuntimeApiKey", provider, signal, () =>
        modelRuntime.removeRuntimeApiKey(provider, { signal }),
      ),
    // SDK の検証は登録内容の反映前に行われるため、throw しても旧登録は残る (呼び出し側が 400 にする)
    registerProvider: (provider, config) =>
      modelRuntime.registerProvider(provider, {
        name: config.name,
        baseUrl: config.baseUrl,
        api: config.api,
        models: config.models.map((model) => ({ ...model, type: "chat" as const })),
      }),
    unregisterProvider: (provider) => modelRuntime.unregisterProvider(provider),
  };
}

/**
 * SDK は Map への commit 後に同期が失敗した場合も CSE を投げるため、例外を「未適用」と見なさない。
 * provider / operation が一致する CSE だけを commit 済みと判定し、timeout・実行中 abort は unknown に倒す。
 */
async function commitCredential(
  operation: "setRuntimeApiKey" | "removeRuntimeApiKey",
  provider: string,
  signal: AbortSignal,
  run: () => Promise<unknown>,
): Promise<CredentialCommit> {
  // 開始前と確実に識別できる abort だけを not_applied とする (呼び出し側の timeout が先に切れている場合)。
  if (signal.aborted) return { outcome: "not_applied" };
  try {
    await run();
    return { outcome: "applied", synced: true };
  } catch (error) {
    if (error instanceof CredentialSynchronizationError) {
      return error.providerId === provider && error.operation === operation
        ? { outcome: "applied", synced: false }
        : { outcome: "unknown" };
    }
    return { outcome: "unknown" };
  }
}
