import { join } from "node:path";
import { CredentialSynchronizationError, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { PiBff } from "./agent";
import type { BackupModelResolver } from "./backup/plan";
import { CODEX_PROVIDER_ID, codexAuthOf, codexAuthStatusOf } from "./codex-images";
import { createDeviceIdStore, DEVICE_ID_PATH } from "./device-id";
import type { CodexAuth, ImageAuthStatus } from "./images";
import type { CredentialCommit, ProviderKeyRuntime } from "./model-settings";
import { canSignInHere, type OAuthLoginRuntime } from "./oauth-login";
import type { ModelRef } from "./schema";
import type { WebSearchRuntimeConfig } from "./web-search-tool";
import { createWebSearchTest, type WebSearchTest } from "./web-search-test";
import { createTitleSummaryGenerate, type TitleSummaryGenerate } from "./title-summary";

/**
 * ランタイムの差し込み先。pi が無いときに止まる機能の代替をここで 1 回だけ決め、段はこの値だけを見る
 * (段ごとに `pi ? … : …` を書かない)。
 */
export type BffRuntime = {
  /** 組み立てられた pi。SDK の実体か agent dir が要る段だけが読む */
  pi: PiBff | null;
  /** モデル・生成・資格情報の実体があるか。無いときの status と文言は各サービスが自分で決める */
  available: boolean;
  /** 可変マスカーなので、起動後に登録されたキーにも効く。pi が無いときだけ素通しになる */
  maskError: (text: string) => string;
  /** ログのマスカー。pi が無いときは undefined で、渡された側はマスク無しで動く */
  masker: PiBff["secretMasker"] | undefined;
  retainSecret: (value: string) => void;
  refreshModelState: PiBff["refreshModelState"];
  setModelSelection: PiBff["setModelSelection"];
  setContentGeneration: PiBff["setContentGeneration"];
  setWebSearch: PiBff["setWebSearch"];
  setSpeechFormatStore: PiBff["setSpeechFormatStore"];
  setGitIdentity: PiBff["setGitIdentity"];
  setSessionEnv: PiBff["setSessionEnv"];
  setServe: PiBff["setServe"];
  setAskUser: PiBff["setAskUser"];
  setNetworkAccess: PiBff["setNetworkAccess"];
  setInvestigate: PiBff["setInvestigate"];
  /** コンテンツ生成の試行へ渡す生成器。無いときは試行の開始が 503 になる */
  generateImage: PiBff["generateImage"] | undefined;
  generateSpeech: PiBff["generateSpeech"] | undefined;
  generateBgm: PiBff["generateBgm"] | undefined;
  /** ツールの実効一覧 (カタログの応答)。無いときは空 = クライアントが「取得できていない」と出す */
  toolCatalog: () => ReturnType<PiBff["toolCatalog"]>;
  /** バックアップの既知ツール。undefined は「一覧を取れない = 照合しない」なので空にしない */
  knownToolNames: () => string[] | undefined;
  modelOptions: () => PiBff["modelOptions"];
  /** マスカーが持つ秘密値 (公開時に本文から伏せる)。無いときは空 */
  secretValues: () => readonly string[];
  /** テスト検索はツールと同じ runner と同じ設定の写しを使う。無いときは null (画面は実行できないと出す) */
  webSearchTest: (runtime: () => WebSearchRuntimeConfig, fetchImpl?: typeof fetch) => WebSearchTest | null;
  /** 会話タイトルの要約。生成器そのものの差し替えは呼び出し側 (起動オプション) が先に見る */
  titleSummaryGenerate: () => TitleSummaryGenerate | null;
  /** 復元するモデルの可否。無いときは判断せず保持する (docs/backup.md) */
  backupModels: (readAllowedModels: () => readonly ModelRef[] | null) => BackupModelResolver;
  /** OAuth サインインの SDK 面。無いときは null (サインインだけが 503 になる) */
  oauthLogin: () => OAuthLoginRuntime | null;
  /** プロバイダー API キーの SDK 面。無いときは null (キーの読み書きだけが 503 になる) */
  providerKeys: () => ProviderKeyRuntime | null;
  codexAuth: {
    status: () => ImageAuthStatus;
    resolve: () => Promise<CodexAuth | undefined>;
  };
};

/** pi の有無で変わる差し込み先をまとめる。ランタイムなしの扱いを決めるのはこの関数だけ */
export function createBffRuntime(pi: PiBff | null): BffRuntime {
  return {
    pi,
    available: pi !== null,
    maskError: (text) => (pi ? pi.secretMasker.mask(text) : text),
    masker: pi?.secretMasker,
    retainSecret: (value) => pi?.retainSecret(value),
    // 期限 (signal) は呼び出し側が握るので、引数をそのまま渡す
    refreshModelState: (options) => (pi ? pi.refreshModelState(options) : Promise.resolve()),
    setModelSelection: (selection) => pi?.setModelSelection(selection),
    setContentGeneration: (config) => pi?.setContentGeneration(config),
    setWebSearch: (config) => pi?.setWebSearch(config),
    setSpeechFormatStore: (store) => pi?.setSpeechFormatStore(store),
    setGitIdentity: (source) => pi?.setGitIdentity(source),
    setSessionEnv: (source) => pi?.setSessionEnv(source),
    setServe: (host) => pi?.setServe(host),
    setAskUser: (host) => pi?.setAskUser(host),
    setNetworkAccess: (host) => pi?.setNetworkAccess(host),
    setInvestigate: (host) => pi?.setInvestigate(host),
    generateImage: pi?.generateImage,
    generateSpeech: pi?.generateSpeech,
    generateBgm: pi?.generateBgm,
    toolCatalog: () => pi?.toolCatalog() ?? [],
    knownToolNames: () => pi?.toolCatalog().map((tool) => tool.name),
    modelOptions: () => pi?.modelOptions ?? [],
    secretValues: () => pi?.secretMasker.secrets ?? [],
    webSearchTest: (runtime, fetchImpl) =>
      pi
        ? createWebSearchTest({
            runtime,
            masker: pi.secretMasker,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          })
        : null,
    titleSummaryGenerate: () =>
      pi
        ? createTitleSummaryGenerate(
            {
              resolveModel: (model) => pi.resolveModel(model),
              // sessionId (プロバイダーのルーティング)・出力予算・Effort・取消をそのまま渡す
              complete: (model, context, options) => pi.modelRuntime.completeSimple(model, context, options),
            },
            pi.secretMasker,
          )
        : null,
    backupModels: (readAllowedModels) => {
      if (!pi || pi.availabilityError) return () => "unknown";
      return (model) => {
        const runtimeCatalog = pi.modelCatalog;
        if (!runtimeCatalog || runtimeCatalog.catalogCount === 0) return "unknown";
        const inCatalog = runtimeCatalog.providers.some(
          (provider) => provider.provider === model.provider && provider.models.some((entry) => entry.id === model.id),
        );
        if (!inCatalog) return "not_in_catalog";
        let allowed: readonly ModelRef[] | null = null;
        try {
          allowed = readAllowedModels();
        } catch {
          // 許可リストを読めないときは「明示的な除外」を判断しない (モデルを落とさない)
          allowed = null;
        }
        if (allowed && !allowed.some((ref) => ref.provider === model.provider && ref.id === model.id)) {
          return "not_allowed";
        }
        if (pi.modelOptions.length === 0) return "unknown";
        return pi.resolveModel(model) ? "available" : "unknown";
      };
    },
    oauthLogin: () => (pi ? createOAuthLoginRuntime(pi) : null),
    providerKeys: () => (pi ? createProviderKeyRuntime(pi) : null),
    // 表示には auth.json の保存値だけを使う（GET でトークン解決・外部通信を起こさない）。
    // 生成の実行時だけ SDK に解決させ、返ったアクセストークンはマスカーへ入れてから使う
    codexAuth: {
      status: () => (pi ? codexAuthStatusOf(join(pi.agentDir, "auth.json")) : { state: "missing", kind: null }),
      resolve: async () => {
        if (!pi) return undefined;
        const auth = await pi.modelRuntime.getAuth(CODEX_PROVIDER_ID);
        const access = auth?.auth.apiKey;
        if (access) pi.retainSecret(access);
        return codexAuthOf(access);
      },
    },
  };
}

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
