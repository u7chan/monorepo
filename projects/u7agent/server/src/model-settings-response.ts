/**
 * 設定 → モデルの応答 DTO の組み立て。GET と変更系は同じ形を返すため、DB の生きた行とランタイムの
 * 現在値だけから 1 か所で作る (ここは読むだけで、DB / SDK / サービスの状態を変えない)。
 * 契約は docs/model-settings.md の「応答契約」を正とする。
 */
import type { CustomProviderRow, ProviderCredentialRow, ProviderMemoRow } from "./app-db";
import { appSecretNotStored, appSecretUnevaluated, type AppSecretState } from "./app-secrets";
import { sanitizeRuntimeAuth, type RuntimeAuthStatusLike } from "./model-state";
import {
  customProviderSummary,
  customProviderSummaryOfRow,
  type CustomProviderSummary,
  type CustomProviderSummarySource,
} from "./custom-providers";
import { formatModelRef } from "./model-ref";
import type {
  CredentialKind,
  ModelRef,
  ModelsSettingsResponse,
  OAuthLoginState,
  ProviderAuthSetting,
  RuntimeAuth,
} from "./schema";

/** 応答に載せる provider の静的 metadata。並びはそのまま `providers[]` の順になる */
export interface ModelSettingsRuntimeProvider {
  provider: string;
  name: string;
  canSetApiKey: boolean;
  supportsOAuth: boolean;
  /** この画面でサインインを完了できる provider か。表示専用の判定で、login API の対象判定には使わない */
  canSignInHere: boolean;
  /** provider の `oauth.loginLabel`。OAuth の表示名だけに使う静的 metadata で、null = OAuth なし */
  oauthLoginLabel: string | null;
}

/** 応答を組むのに読むランタイムの面。null (初期化失敗) は `runtimeAvailable: false` として表す */
export interface ModelSettingsRuntimeView {
  list(): ModelSettingsRuntimeProvider[];
  auth(provider: string): RuntimeAuthStatusLike | undefined;
  /**
   * SDK が見ている資格情報の種別 (`ModelRuntime.isUsingOAuth`)。認証なしは null。runtime overlay がある
   * ときは overlay の api_key を返し、auth.json の保存値は見えない (見えない差は storedCredentialKind())。
   */
  credentialKind(provider: string): CredentialKind | null;
  /**
   * auth.json の保存資格情報の種別。runtime overlay があると SDK からは保存値を覗けないため、警告表示の
   * 判定にだけ使う。値は返さず、読取失敗・壊れた JSON は undefined (= 不明) へ縮退させる。
   */
  storedCredentialKind(provider: string): CredentialKind | undefined;
}

export interface ModelSettingsResponseInput {
  runtime: ModelSettingsRuntimeView | null;
  /** `provider_credentials` の生きた行。`managed` はこの行の有無だけで決める */
  credentialRows: ProviderCredentialRow[];
  memos: ProviderMemoRow[];
  /** 保存値の選択。allowedModels の null は制限なし、defaultModel の null は既定なし */
  selection: { allowedModels: ModelRef[] | null; defaultModel: string | null };
  /** `custom_providers` の生きた行。一覧 (`customProviders[]`) の正はこちらだけにする */
  customRows: CustomProviderRow[];
  /**
   * 一覧を読めず credentialRows が空のときだけ渡せる「行があると確定している」provider の補正で、
   * 呼び出し側が書込/読取の成功で保証できる apply のときだけ使う (DELETE では渡さない)。
   */
  assumedManaged?: string;
  /** このプロセスで `registerProvider()` に成功したカスタム provider の id */
  customRegistered: ReadonlySet<string>;
  /** 削除の後始末が未完了の定義。DB 行の無いものだけを一覧の末尾に足す */
  tombstones: ReadonlyMap<string, CustomProviderSummarySource>;
  /** provider ごとの未反映の印。キー変更とカスタムプロバイダーが同じ表を共有する */
  degraded: ReadonlyMap<string, "apply" | "remove">;
  /** degraded の固定文言。原因はサーバーが決め、クライアントに推測させない */
  degradedMessages: ReadonlyMap<string, string>;
  /** 保存済みキーの復号結果。行があるのに載っていない provider は未評価として返す */
  secretStates: ReadonlyMap<string, AppSecretState>;
  oauthLogin: { stateOf(provider: string): OAuthLoginState | null } | null;
  ignoredEnvironmentVariables: readonly string[];
}

/**
 * GET / 変更系の応答 DTO。rows は DB の生きた行で、`managed` はこの行の有無だけで決める。
 * memos は provider に紐づく人間用メモで、行がある provider は credential / カタログに無くても
 * orphan として出す (managed は false のままで、バッジは既存の「カタログ外」に落ちる)。
 * 同じ id の `provider_credentials` / `provider_memos` は DB に残っていても DTO へ混ぜない
 * (カスタム側が正で、通常行の `managed` / メモを持たせると同じ id の管理状態が二重になる)。
 */
export function composeModelSettingsResponse(input: ModelSettingsResponseInput): ModelsSettingsResponse {
  const customRowIds = new Set(input.customRows.map((row) => row.provider));
  const credentialRows = input.credentialRows.filter((row) => !customRowIds.has(row.provider));
  const memoRows = input.memos.filter((row) => !customRowIds.has(row.provider));
  const managed = new Set(credentialRows.map((row) => row.provider));
  if (input.assumedManaged) managed.add(input.assumedManaged);
  const memoOf = new Map(memoRows.map((row) => [row.provider, row.memo]));
  const updatedAtOf = new Map(credentialRows.map((row) => [row.provider, row.updatedAt]));
  // 行が無い (= managed でない) provider は保存日時も不明として null にする
  const keyUpdatedAtOf = (provider: string): number | null =>
    managed.has(provider) ? (updatedAtOf.get(provider) ?? null) : null;
  const providers = new Map<string, ProviderAuthSetting>();
  const customIds = new Set(input.customRegistered);
  // 行があるのにキャッシュに無い provider は「保存済みだが復号をまだ確認していない」= 未評価
  const keyStateOf = (provider: string): AppSecretState =>
    managed.has(provider) ? (input.secretStates.get(provider) ?? appSecretUnevaluated()) : appSecretNotStored();
  const settingOf = (
    provider: string,
    name: string,
    auth: RuntimeAuthStatusLike | undefined,
    flags: {
      managed: boolean;
      canSetApiKey: boolean;
      supportsOAuth: boolean;
      canSignInHere: boolean;
      orphan: boolean;
      /** provider_credentials に行がある。orphan への degraded 自動付与は適用対象のキーがあるときだけ */
      appliable: boolean;
    },
    memo: string | undefined,
    keyUpdatedAt: number | null,
    /** 保存済みキーの復号結果。行が無い provider は未保存として扱う */
    secretState: AppSecretState,
    /** provider の `oauth.loginLabel`。カタログ外の provider は OAuth の表示名を知らないため null */
    oauthLoginLabel: string | null,
    /** 設定 → モデルで作ったカスタムプロバイダー (OAuth の対象外) */
    custom: boolean,
  ): ProviderAuthSetting => {
    const degraded =
      flags.orphan && flags.appliable && !input.degraded.has(provider) ? "apply" : input.degraded.get(provider);
    const sanitized: RuntimeAuth = sanitizeRuntimeAuth(auth);
    return {
      provider,
      name,
      auth: sanitized,
      managed: flags.managed,
      canSetApiKey: flags.canSetApiKey,
      supportsOAuth: flags.supportsOAuth,
      canSignInHere: flags.canSignInHere,
      credentialKind: credentialKindOf(input.runtime, provider, sanitized),
      oauthLoginLabel,
      // カスタムプロバイダーは auth.json の OAuth を持たないので、表示専用の読取も行わない
      hiddenStoredOAuth: sanitized.source === "runtime" && !custom && storedOAuthHidden(input.runtime, provider),
      orphan: flags.orphan,
      ...(custom ? { custom: true } : {}),
      login: input.oauthLogin?.stateOf(provider) ?? null,
      ...(degraded ? { degraded } : {}),
      memo: memo ?? null,
      keyUpdatedAt,
      keyAvailable: flags.managed && secretState.keyAvailable,
      keyEvaluated: flags.managed ? secretState.keyEvaluated : true,
      keyErrorMessage: flags.managed ? secretState.keyErrorMessage : null,
    };
  };
  for (const entry of input.runtime?.list() ?? []) {
    providers.set(
      entry.provider,
      settingOf(
        entry.provider,
        entry.name,
        input.runtime?.auth(entry.provider),
        {
          managed: managed.has(entry.provider),
          canSetApiKey: entry.canSetApiKey,
          supportsOAuth: entry.supportsOAuth,
          canSignInHere: entry.canSignInHere,
          orphan: false,
          appliable: managed.has(entry.provider),
        },
        memoOf.get(entry.provider),
        keyUpdatedAtOf(entry.provider),
        keyStateOf(entry.provider),
        entry.oauthLoginLabel,
        customIds.has(entry.provider),
      ),
    );
  }
  for (const row of credentialRows) {
    if (providers.has(row.provider)) continue;
    // カタログに無い行 (orphan) は SDK へ適用できないため、未反映として復旧・削除の導線を出す
    providers.set(
      row.provider,
      settingOf(
        row.provider,
        row.provider,
        undefined,
        {
          managed: true,
          canSetApiKey: false,
          supportsOAuth: false,
          canSignInHere: false,
          orphan: true,
          appliable: true,
        },
        memoOf.get(row.provider),
        keyUpdatedAtOf(row.provider),
        keyStateOf(row.provider),
        null,
        customIds.has(row.provider),
      ),
    );
  }
  for (const row of memoRows) {
    if (providers.has(row.provider)) continue;
    // メモだけの provider。キーの行ではないので managed / degraded を付けず、メモ欄と消去の導線だけを残す
    providers.set(
      row.provider,
      settingOf(
        row.provider,
        row.provider,
        undefined,
        {
          managed: false,
          canSetApiKey: false,
          supportsOAuth: false,
          canSignInHere: false,
          orphan: true,
          appliable: false,
        },
        row.memo,
        keyUpdatedAtOf(row.provider),
        keyStateOf(row.provider),
        null,
        customIds.has(row.provider),
      ),
    );
  }
  // 削除に失敗した overlay は DB 行が無く、カタログからも消えていることがある。行が無くても再同期の導線を残す。
  // カスタム行と削除待ち tombstone は `customProviders[]` だけに出す: runtime に実体が無い行をここで足すと、
  // 通常一覧に同じ id の幽霊行が出る (built-in / models.json と衝突して未登録の行も同じ)。
  for (const provider of input.degraded.keys()) {
    if (customRowIds.has(provider) || input.tombstones.has(provider)) continue;
    if (providers.has(provider)) continue;
    providers.set(
      provider,
      settingOf(
        provider,
        provider,
        undefined,
        {
          managed: managed.has(provider),
          canSetApiKey: false,
          supportsOAuth: false,
          canSignInHere: false,
          orphan: true,
          appliable: false,
        },
        memoOf.get(provider),
        keyUpdatedAtOf(provider),
        keyStateOf(provider),
        null,
        customIds.has(provider),
      ),
    );
  }
  return {
    runtimeAvailable: input.runtime !== null,
    // 応答は "provider/model" の一覧にする (DB 行は ModelRef の JSON 配列)
    allowedModels: input.selection.allowedModels?.map(formatModelRef) ?? null,
    defaultModel: input.selection.defaultModel,
    ignoredEnvironmentVariables: [...input.ignoredEnvironmentVariables],
    providers: [...providers.values()],
    customProviders: customSummaries(input.customRows, input),
  };
}

/**
 * カスタムプロバイダーの一覧。順序は DB 行の追加順で、削除待ち tombstone は行の無いものだけを
 * 末尾に足す (未反映のまま画面から漏れないようにする)。GET は復号しないので、hasKey は暗号文の有無で決める。
 */
function customSummaries(rows: CustomProviderRow[], input: ModelSettingsResponseInput): CustomProviderSummary[] {
  const listed = new Set(rows.map((row) => row.provider));
  const summaries = rows.map((row) => {
    // runtime の無い構成は保存内容だけを返す (反映済み / 未反映の区別はランタイム警告に任せる)
    if (!input.runtime) return customProviderSummaryOfRow(row);
    return customProviderSummaryOfRow(row, {
      degraded: input.degraded.get(row.provider),
      degradedMessage: input.degradedMessages.get(row.provider) ?? null,
    });
  });
  for (const [id, tombstone] of input.tombstones) {
    if (listed.has(id)) continue;
    summaries.push(customProviderSummary(tombstone, { hasKey: false, degraded: "remove" }));
  }
  return summaries;
}

/** SDK が見ている種別。認証なしの provider には聞かない (unconfigured では種別が無い) */
function credentialKindOf(
  runtime: ModelSettingsRuntimeView | null,
  provider: string,
  auth: RuntimeAuth,
): CredentialKind | null {
  if (!auth.configured) return null;
  return runtime?.credentialKind(provider) ?? null;
}

/**
 * この画面のキーが auth.json の OAuth を覆っているか。表示専用の auth.json 読取で、失敗は
 * 「不明」として false へ縮退させ、設定 API を読取の失敗で落とさない。
 */
function storedOAuthHidden(runtime: ModelSettingsRuntimeView | null, provider: string): boolean {
  try {
    return runtime?.storedCredentialKind(provider) === "oauth";
  } catch {
    return false;
  }
}
