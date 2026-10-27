/**
 * 設定 → モデル (プロバイダーAPIキー) のサービス。
 * アプリ DB を希望状態の正として先に確定し、SDK の runtime overlay へ写す。写しに失敗しても DB は戻さず、
 * degraded (保存済み・未反映) として記録して resync / 次回変更 / 再起動で収束させる (補償ロールバックは持たない)。
 * 契約と残存リスクは docs/model-settings.md を正とする。
 */
import type {
  CustomProviderRow,
  ModelSettingsRow,
  ProviderCredentialRow,
  ProviderMemoRow,
  StoredAppSecret,
} from "./app-db";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
  appSecretAvailable,
  appSecretFailed,
  appSecretMasterKeyMissing,
  appSecretNotStored,
  appSecretUnevaluated,
  type AppSecretState,
} from "./app-secrets";
import { sanitizeRuntimeAuth, type ModelCatalogRefreshAttempt, type RuntimeAuthStatusLike } from "./agent";
import { CUSTOM_PROVIDER_PROBE_TIMEOUT_MS, probeCustomProviderModels } from "./custom-provider-probe";
import {
  CUSTOM_PROVIDER_API_KEY_MESSAGE,
  CUSTOM_PROVIDER_ID_CONFLICT_DEGRADED_MESSAGE,
  CUSTOM_PROVIDER_INVALID_STORED_MESSAGE,
  CUSTOM_PROVIDER_KEY_TARGET_MESSAGE,
  CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE,
  CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  CUSTOM_PROVIDER_NOT_STORED_MESSAGE,
  CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  CUSTOM_PROVIDER_STORED_ROWS_MESSAGE,
  CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE,
  assertCustomProviderIdAvailable,
  customProviderRowOf,
  customProviderRuntimeConfig,
  customProviderSummary,
  customProviderSummaryOfRow,
  parseCustomProviderApiKey,
  parseCustomProviderInput,
  parseCustomProviderUpdate,
  storedCustomProviderDefinition,
  type CustomProviderDefinition,
  type CustomProviderInput,
  type CustomProviderRuntimeConfig,
  type CustomProviderSummary,
  type CustomProviderSummarySource,
  type CustomProviderUpdateInput,
} from "./custom-providers";
import { httpError, messageFor } from "./http";
import type { AppSecretCipher } from "./secret-crypto";
import {
  PROVIDER_API_KEY_MIN_LENGTH,
  RUNTIME_MODELS_UNAVAILABLE_MESSAGE,
  type CredentialKind,
  type CustomProviderProbeResponse,
  type ModelCatalogRefreshResponse,
  type ModelRef,
  type ModelsSettingsResponse,
  type ModelMutationResponse,
  type OAuthLoginState,
  type ProviderAuthSetting,
  type RuntimeAuth,
  type RuntimeModelsResponse,
} from "./schema";

/** SDK 操作の結果。CSE は「commit 済み・同期失敗」、unknown は commit の有無を断定しない。 */
export type CredentialCommit =
  | { outcome: "applied"; synced: true }
  | { outcome: "applied"; synced: false }
  | { outcome: "not_applied" }
  | { outcome: "unknown" };

/** SDK commit と state 再計算を分離する継ぎ目。state の再導出は呼び出し側 (このサービス) が担う。 */
export interface ProviderKeyRuntime {
  list(): {
    provider: string;
    name: string;
    canSetApiKey: boolean;
    supportsOAuth: boolean;
    /** この画面でサインインを完了できる provider か。表示専用の判定で、login API の対象判定には使わない */
    canSignInHere: boolean;
    /** provider の `oauth.loginLabel`。OAuth の表示名だけに使う静的 metadata で、null = OAuth なし */
    oauthLoginLabel: string | null;
  }[];
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
  /**
   * カタログの provider/model。保存値の検証はここを引き、認証状態に依存する `getAvailable()` へ
   * 依存させない (未認証でも許可リストには入れられる)。
   */
  catalog(): ModelRef[];
  /**
   * pi.dev の provider 別カタログを取り直す。offline の判定と総時間の上限は呼び出し側が持ち、
   * ここは SDK へ写すだけ (例外は呼び出し側が固定文言へ寄せる)。
   */
  refreshCatalog(options: {
    allowNetwork: boolean;
    force: boolean;
    signal: AbortSignal;
  }): Promise<ModelCatalogRefreshAttempt>;
  /**
   * いま公開しているカタログ応答。取得できなかった回は undefined で、`GET /api/runtime/models` と同じ 503 にする。
   * lock の内側で `refreshModelState()` の後に読む契約。
   */
  catalogSnapshot(): RuntimeModelsResponse | undefined;
  applyApiKey(provider: string, apiKey: string, options: { signal: AbortSignal }): Promise<CredentialCommit>;
  removeApiKey(provider: string, options: { signal: AbortSignal }): Promise<CredentialCommit>;
  /**
   * SDK へ provider を登録する。SDK は変更前に検証するため、throw しても旧登録は残る
   * (例外の文言は呼び出し側が固定文言へ寄せる)。SDK の型はここへ持ち込まない。
   */
  registerProvider(provider: string, config: CustomProviderRuntimeConfig): void;
  /** SDK から provider を外す。runtime overlay (キー) は消さないので、削除時は removeApiKey を先に呼ぶ */
  unregisterProvider(provider: string): void;
}

export interface ModelSettingsDb {
  listProviderCredentials(): ProviderCredentialRow[];
  getProviderCredential(provider: string): ProviderCredentialRow | undefined;
  /** 値は暗号化済みの保存形だけを渡す (平文は DB へ書かない) */
  saveProviderCredential(provider: string, secret: StoredAppSecret, updatedAt: number): void;
  deleteProviderCredential(provider: string): boolean;
  /** 行が無ければ undefined = 未設定。空文字の行も未設定として返す */
  listProviderMemos(): ProviderMemoRow[];
  getProviderMemo(provider: string): ProviderMemoRow | undefined;
  saveProviderMemo(provider: string, memo: string): void;
  deleteProviderMemo(provider: string): boolean;
  /** 行が無ければ undefined = 未設定 */
  readModelSettings(): ModelSettingsRow | undefined;
  saveModelSettings(settings: ModelSettingsRow): void;
  /** 追加順 (rowid)。行が無ければ「カスタムプロバイダーなし」 */
  listCustomProviders(): CustomProviderRow[];
  getCustomProvider(provider: string): CustomProviderRow | undefined;
  /** 定義と暗号文を 1 行で upsert する (キーの平文は受け取らない) */
  saveCustomProvider(row: CustomProviderRow): void;
  deleteCustomProvider(provider: string): boolean;
}

/** 保存値としての利用可能なモデル / アプリ既定モデル。allowedModels の null は制限なし、defaultModel の null は既定なし */
export interface StoredModelSelection {
  allowedModels: ModelRef[] | null;
  defaultModel: string | null;
}

export interface ModelSettingsOptions {
  db: ModelSettingsDb;
  /** null = ランタイム初期化失敗。GET は runtimeAvailable: false、変更系は 503 not_stored */
  runtime: ProviderKeyRuntime | null;
  /**
   * OAuth サインインの進行状態 (メモリだけが持つ)。GET はここを読むだけで、ログインの開始・中断は
   * 専用のサービスが担う。null = OAuth サインインを持たない構成 (進行状態なし)。
   */
  oauthLogin?: { stateOf(provider: string): OAuthLoginState | null } | null;
  /** SDK / DB へ触る前に保護対象へ足す (マスカーの swap は同期) */
  retainSecret: (value: string) => void;
  /** health / ログへ出す前の文言境界 (可変マスカー) */
  maskError: (text: string) => string;
  /** アプリ DB のキー用の AEAD。master key が無い / 不正なときは null で、保存と復号を拒否する */
  appCipher?: AppSecretCipher | null;
  /**
   * 公開 state の再計算。例外を出さない契約。`signal` は取得と同じ期限で、期限切れの結果で state を差し替えない
   * (取得の失敗と読み取りの中断を混ぜず、一覧を現在値のまま保つため)。
   */
  refreshModelState: (options?: { signal?: AbortSignal }) => Promise<void>;
  /**
   * 保存値の適用。公開 state へ効かせるのは refreshModelState() なので、必ず setter → refresh の順に呼ぶ。
   * undefined は未設定を表す (allowedModels は制限なし、defaultModel は既定なし)。
   */
  setModelSelection: (selection: { allowedModels: ModelRef[] | undefined; defaultModel: ModelRef | undefined }) => void;
  /** 残っていて無視している移行前の環境変数名。画面の注記と起動ログが同じ値を使う */
  ignoredEnvironmentVariables: string[];
  /** SDK 操作の期限。timeout は「未適用」と断定せず unknown に倒す */
  timeoutMs?: number;
  /** カスタムプロバイダーの `/models` probe の期限。一覧取得は短く閉じる */
  probeTimeoutMs?: number;
  /** `/models` probe の fetch (テスト用)。省略時は globalThis.fetch */
  probeFetch?: typeof fetch;
  /** pi.dev へのカタログ取得の総時間の上限。provider ごとの試行より外側の期限 */
  catalogTimeoutMs?: number;
}
export const PROVIDER_KEY_SYNC_TIMEOUT_MS = 20_000;
export const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 20_000;

export const PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、APIキーを変更できません";
export const PROVIDER_KEY_NOT_STORED_MESSAGE = "APIキーをアプリデータ（SQLite）へ保存できませんでした";
export const PROVIDER_KEY_TARGET_MESSAGE = "このプロバイダーにはAPIキーを登録できません";
export const PROVIDER_KEY_NOT_MANAGED_MESSAGE = "この画面で登録したAPIキーがありません";
export const PROVIDER_RESYNC_TARGET_MESSAGE = "このプロバイダーは再同期できません";
export const PROVIDER_MEMO_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、メモを保存できません";
export const PROVIDER_MEMO_NOT_STORED_MESSAGE = "メモをアプリデータ（SQLite）へ保存できませんでした";
export const PROVIDER_MEMO_TARGET_MESSAGE = "このプロバイダーのメモは保存できません";
export const MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、利用可能なモデルを変更できません";
export const MODEL_SELECTION_NOT_STORED_MESSAGE = "利用可能なモデルをアプリデータ（SQLite）へ保存できませんでした";
export const MODEL_SELECTION_FORMAT_MESSAGE = "モデルは provider/model 形式で指定してください";
export const MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE = "カタログに無いモデルは指定できません";
export const MODEL_SELECTION_DEFAULT_NOT_ALLOWED_MESSAGE = "既定モデルは利用可能なモデルから選んでください";
export const MODEL_CATALOG_ERROR_PARTIAL =
  "一部のプロバイダーからモデル一覧を取得できませんでした。取得できた範囲で一覧を更新しています。";
export const MODEL_CATALOG_ERROR_TIMEOUT =
  "モデル一覧の取得がタイムアウトしました。取得できた範囲で一覧を更新しています。";
export const MODEL_CATALOG_ERROR_OFFLINE =
  "PI_OFFLINE が設定されているためモデル一覧を取得しませんでした。表示中の一覧は変わりません。";
export const MODEL_CATALOG_ERROR_UNKNOWN = "モデル一覧を取得できませんでした。表示中の一覧は変わりません。";

export type MutationOutcome = { status: 200; response: ModelMutationResponse } | { status: 503; error: string };

/**
 * カスタムプロバイダーの変更結果。DB を先に確定し、SDK への反映失敗は 200 `applied_unsynced`（degraded）で返す。
 * 503 は **DB 確定前**（読取 / 書込失敗、入力キーの暗号化失敗、ランタイム未初期化）だけに使う。
 */
export type CustomProviderOutcome = { status: 200; response: ModelMutationResponse } | { status: 503; error: string };

/** カタログ更新の応答。503 は一覧そのものを返せないときだけで、取得失敗は 200 の `catalogError` に載せる */
export type CatalogRefreshOutcome =
  | { status: 200; response: ModelCatalogRefreshResponse }
  | { status: 503; error: string };

/**
 * 認証変更・DB 書込・state 公開を直列化する 1 本のロック。コンテンツ生成の設定も同じ型のロックで直列化する。
 * 前のタスクの失敗でチェーンを止めず、呼び出し側へは自分のタスクの結果だけを返す。
 */
export class MutationLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** 一度目の commit が applied/synced でなければ、同じ操作を 1 回だけ再試行する (冪等) */
async function applyWithRetry(run: () => Promise<CredentialCommit>): Promise<CredentialCommit> {
  const first = await run();
  if (first.outcome === "applied" && first.synced) return first;
  return run();
}

function commitSucceeded(commit: CredentialCommit): boolean {
  return commit.outcome === "applied" && commit.synced;
}

const modelKey = ({ provider, id }: ModelRef): string => JSON.stringify([provider, id]);

const labelOf = ({ provider, id }: ModelRef): string => `${provider}/${id}`;

/** "provider/model" を ModelRef へ。id の slash は先頭の 1 つだけで分ける (openrouter/anthropic/...) */
function parseModelRef(value: string): ModelRef {
  const text = value.trim();
  const slash = text.indexOf("/");
  const provider = slash === -1 ? "" : text.slice(0, slash).trim();
  const id = slash === -1 ? "" : text.slice(slash + 1).trim();
  // provider に slash は入らない。model id には入り得るので許可する
  if (!provider || !id || provider.includes("/")) throw httpError(400, MODEL_SELECTION_FORMAT_MESSAGE);
  return { provider, id };
}

/** 重複を先勝ちで落とし、空配列を「制限なし」の null へ寄せる。形式の誤りは 400 */
function normalizeAllowedModels(input: string[] | null): ModelRef[] | null {
  if (!input) return null;
  const seen = new Set<string>();
  const normalized: ModelRef[] = [];
  for (const entry of input) {
    const ref = parseModelRef(entry);
    const key = modelKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(ref);
  }
  return normalized.length > 0 ? normalized : null;
}

/** 手で編集された保存値を起動時に読んだときは落とさない。画面から保存し直せば正規化される */
function parseStoredDefaultModel(value: string | null): ModelRef | undefined {
  if (!value) return undefined;
  try {
    return parseModelRef(value);
  } catch {
    return undefined;
  }
}

export class ModelSettingsService {
  #db: ModelSettingsDb;
  #runtime: ProviderKeyRuntime | null;
  #retainSecret: (value: string) => void;
  #maskError: (text: string) => string;
  #refreshModelState: (options?: { signal?: AbortSignal }) => Promise<void>;
  #setModelSelection: ModelSettingsOptions["setModelSelection"];
  #ignoredEnvironmentVariables: string[];
  #timeoutMs: number;
  #probeTimeoutMs: number;
  #probeFetch: typeof fetch | undefined;
  #catalogTimeoutMs: number;
  #oauthLogin: { stateOf(provider: string): OAuthLoginState | null } | null;
  #appCipher: AppSecretCipher | null;
  #lock = new MutationLock();
  /** このプロセスのメモリだけが持つ未反映の印。再起動で消える */
  #degraded = new Map<string, "apply" | "remove">();
  /**
   * 保存済みキーの復号結果。起動時と保存 / 置換 / 再同期のときだけ更新し、GET では復号しない。
   * 行があるのに載っていない provider は「未評価」として返す (起動時に DB を読めなかった場合)。
   */
  #secretStates = new Map<string, AppSecretState>();
  /**
   * このプロセスで `registerProvider()` に成功したカスタム provider の id。
   * 更新 / 再同期 / 削除の SDK 操作はこの集合の内側だけに限り、built-in / `models.json` を上書きしない。
   */
  #customRegistered = new Set<string>();
  /**
   * 削除の後始末が未完了の定義。DB 行は消えており、再同期で SDK から外し終わるまで id を予約する。
   * メモリだけが持ち、再起動で消える (再起動後は DB が空から SDK を組むため幽霊 provider は残らない)。
   */
  #tombstones = new Map<string, CustomProviderSummarySource>();
  /** degraded の固定文言。原因はサーバーが決め、クライアントに推測させない */
  #degradedMessages = new Map<string, string>();

  constructor(options: ModelSettingsOptions) {
    this.#db = options.db;
    this.#runtime = options.runtime;
    this.#retainSecret = options.retainSecret;
    this.#maskError = options.maskError;
    this.#refreshModelState = options.refreshModelState;
    this.#setModelSelection = options.setModelSelection;
    this.#ignoredEnvironmentVariables = options.ignoredEnvironmentVariables;
    this.#timeoutMs = options.timeoutMs ?? PROVIDER_KEY_SYNC_TIMEOUT_MS;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? CUSTOM_PROVIDER_PROBE_TIMEOUT_MS;
    this.#probeFetch = options.probeFetch;
    this.#catalogTimeoutMs = options.catalogTimeoutMs ?? MODEL_CATALOG_REFRESH_TIMEOUT_MS;
    this.#oauthLogin = options.oauthLogin ?? null;
    this.#appCipher = options.appCipher ?? null;
  }

  /**
   * GET。変更も修復も行わない純粋読取 (DB の失敗は 503 のまま伝える)。認証種別は SDK の同期スナップショットと、
   * runtime overlay があるときだけ行う auth.json の表示専用読取から組む。
   */
  settings(): ModelsSettingsResponse {
    return this.#compose(
      this.#db.listProviderCredentials(),
      this.#db.listProviderMemos(),
      this.#readSelection(),
      this.#db.listCustomProviders(),
    );
  }

  /**
   * 起動時の適用。ロック 1 回・全行の SDK 適用後に refresh 1 回。
   * 順序はカスタム provider → モデルの選択 → provider_credentials で、選択より先にカスタム provider を
   * カタログへ載せる (許可リストの行が未登録 provider として落ちないようにする)。
   * 3 つの読取は独立に扱い、片方が失敗しても他方の適用と最後の再計算を行う。読めなかったときは
   * 空 DB として黙って続行しない (警告だけ出し、設定 API は 503 のまま)。
   */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      if (!this.#runtime) return;
      const customRows = await this.#applyStoredCustomProviders();
      // 許可リストを読めないときは「未設定 (制限なし)」で続行する (気付けるのはログ / health / 設定 API)
      let selection: StoredModelSelection | undefined;
      try {
        selection = this.#readSelection();
      } catch (error) {
        console.error(`[u7agent] model settings unavailable: ${this.#maskError(messageFor(error))}`);
      }
      if (selection) {
        const defaultModel = parseStoredDefaultModel(selection.defaultModel);
        if (selection.defaultModel && !defaultModel) {
          console.warn(`[u7agent] stored default model is invalid: ${selection.defaultModel}`);
        }
        this.#setModelSelection({ allowedModels: selection.allowedModels ?? undefined, defaultModel });
      }
      let rows: ProviderCredentialRow[];
      try {
        rows = this.#db.listProviderCredentials();
      } catch (error) {
        console.error(`[u7agent] provider credentials unavailable: ${this.#maskError(messageFor(error))}`);
        // キーは適用できないが、上で写した選択は確定させる
        await this.#refresh();
        return;
      }
      // 復号は SDK 適用より先に全行を済ませる (マスカーへ登録してから SDK へ渡す順序を崩さない)
      const catalog = new Set(this.#runtime.list().map((entry) => entry.provider));
      const applyable: { provider: string; apiKey: string }[] = [];
      for (const row of rows) {
        // 同じ id のカスタム行がある場合はカスタム側を正とし、通常キー行は適用しない (行は消さない)
        if (customRows.has(row.provider)) {
          console.warn(`[u7agent] provider key shadowed by custom provider: ${row.provider}`);
          continue;
        }
        // 復号に成功した行だけを SDK へ渡す。復号できない行は平文で代用せず、復号結果をメモリに残す
        const { apiKey, state } = this.#decryptRow(row);
        if (!apiKey) {
          this.#degraded.set(row.provider, "apply");
          console.warn(
            `[u7agent] provider key unavailable: ${row.provider} (${state.keyEvaluated ? "failed" : "unevaluated"})`,
          );
          continue;
        }
        if (apiKey.length < PROVIDER_API_KEY_MIN_LENGTH || !catalog.has(row.provider)) {
          this.#degraded.set(row.provider, "apply");
          continue;
        }
        applyable.push({ provider: row.provider, apiKey });
      }
      for (const { provider, apiKey } of applyable) {
        const commit = await applyWithRetry(() =>
          this.#runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
        );
        if (commitSucceeded(commit)) {
          this.#degraded.delete(provider);
          continue;
        }
        this.#degraded.set(provider, "apply");
        // 値・cause は出さず、provider id と分類だけを残す
        console.warn(`[u7agent] provider key apply deferred: ${provider} (${commit.outcome})`);
      }
      await this.#refresh();
    });
  }

  /**
   * 起動時のカスタム provider の適用。復号 → retainSecret → 検証 → register → key 適用の順を守る。
   * 復号 / 検証に失敗した行は register せず degraded として残し (平文へフォールバックしない)、
   * キーの適用に失敗しても register 済みの ID は外さない (定義は使え、再同期でキーだけ戻せる)。
   */
  async #applyStoredCustomProviders(): Promise<Set<string>> {
    const ids = new Set<string>();
    let rows: CustomProviderRow[];
    try {
      rows = this.#db.listCustomProviders();
    } catch (error) {
      // 行が読めないと「どの provider_credentials を抑えるか」も分からない。ログだけで続行する
      console.error(`[u7agent] custom providers unavailable: ${this.#maskError(messageFor(error))}`);
      return ids;
    }
    const applyable: { definition: CustomProviderDefinition }[] = [];
    for (const row of rows) {
      ids.add(row.provider);
      const { apiKey, state } = this.#decryptCustomKey(row);
      if (!apiKey) {
        this.#markCustomDegraded(row.provider, state.keyErrorMessage);
        console.warn(
          `[u7agent] custom provider key unavailable: ${row.provider} (${state.keyEvaluated ? "failed" : "unevaluated"})`,
        );
        continue;
      }
      let definition: CustomProviderDefinition;
      try {
        definition = storedCustomProviderDefinition(row, apiKey);
      } catch {
        this.#markCustomDegraded(row.provider, CUSTOM_PROVIDER_INVALID_STORED_MESSAGE);
        console.warn(`[u7agent] custom provider definition invalid: ${row.provider}`);
        continue;
      }
      applyable.push({ definition });
    }
    const runtimeProviders = new Set(this.#runtime!.list().map((entry) => entry.provider));
    for (const { definition } of applyable) {
      // 起動時点で built-in / models.json と同じ id がある = 上書きしない。画面は削除を案内する
      if (runtimeProviders.has(definition.id) && !this.#customRegistered.has(definition.id)) {
        this.#markCustomDegraded(definition.id, CUSTOM_PROVIDER_ID_CONFLICT_DEGRADED_MESSAGE);
        console.warn(`[u7agent] custom provider id conflict: ${definition.id}`);
        continue;
      }
      if (!this.#registerCustom(definition)) {
        this.#markCustomDegraded(definition.id, CUSTOM_PROVIDER_ID_CONFLICT_DEGRADED_MESSAGE);
        continue;
      }
      const commit = await this.#applyCustomKey(definition.id, definition.apiKey);
      if (commitSucceeded(commit)) {
        this.#clearCustomDegraded(definition.id);
        continue;
      }
      this.#markCustomDegraded(definition.id);
      console.warn(`[u7agent] custom provider key apply deferred: ${definition.id} (${commit.outcome})`);
    }
    return ids;
  }

  /**
   * 利用可能なモデルとアプリ既定モデルの一括保存。DB 確定後に setter → refresh を 1 回通すだけで、
   * SDK 呼び出しを持たないため degraded は作らない。
   */
  async putModelSelection(input: {
    allowedModels: string[] | null;
    defaultModel: string | null;
  }): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable(MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE);
      const allowedModels = normalizeAllowedModels(input.allowedModels);
      const defaultModel = input.defaultModel === null ? null : parseModelRef(input.defaultModel);
      const catalog = new Map(this.#runtime.catalog().map((model) => [modelKey(model), model]));
      for (const model of allowedModels ?? []) {
        if (!catalog.has(modelKey(model))) {
          throw httpError(400, `${MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE}: ${labelOf(model)}`);
        }
      }
      // 選択可能なモデルは保存値で決まり、制限なしのときはカタログ全体から選べる
      const selectable = allowedModels ?? [...catalog.values()];
      if (defaultModel && !catalog.has(modelKey(defaultModel))) {
        // カタログ外は「既定が許可外」より先に、保存できない理由を具体的に返す
        throw httpError(400, `${MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE}: ${labelOf(defaultModel)}`);
      }
      if (defaultModel && !selectable.some((model) => modelKey(model) === modelKey(defaultModel))) {
        throw httpError(400, `${MODEL_SELECTION_DEFAULT_NOT_ALLOWED_MESSAGE}: ${labelOf(defaultModel)}`);
      }
      const stored: StoredModelSelection = {
        allowedModels,
        defaultModel: defaultModel ? labelOf(defaultModel) : null,
      };
      try {
        this.#db.saveModelSettings(stored);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn("[u7agent] model selection save failed");
        return this.#notStored(MODEL_SELECTION_NOT_STORED_MESSAGE);
      }
      this.#setModelSelection({ allowedModels: allowedModels ?? undefined, defaultModel: defaultModel ?? undefined });
      await this.#refresh();
      try {
        return { status: 200, response: { ...this.settings(), state: "applied" } };
      } catch {
        // DB への保存は確定している。一覧を組めない応答でも保存済みを伝え、次の GET で追随させる
        return {
          status: 200,
          response: {
            ...this.#compose([], this.#memosOrEmpty(), stored, this.#customRowsOrEmpty()),
            state: "applied",
          },
        };
      }
    });
  }

  /**
   * provider のメモ (人間用の任意文字列) の保存。SDK 呼び出しを含まないため degraded は作らず、
   * キーの登録有無 (managed) も変えない。trim して空なら行を消して未設定へ戻す。
   */
  async putMemo(provider: string, memo: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      this.#assertNotCustomProvider(provider, CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE);
      // メモは SDK の認証状態に依存しないが、GET と揃えてランタイム無しでは受け付けない
      if (!this.#runtime) return this.#runtimeUnavailable(PROVIDER_MEMO_RUNTIME_UNAVAILABLE_MESSAGE);
      const inCatalog = this.#runtime.list().some((candidate) => candidate.provider === provider);
      if (!inCatalog) {
        let known: boolean;
        try {
          // カタログ外は credential 行かメモ行が既にあるときだけ許す (canSetApiKey では gate しない)
          known =
            this.#db.getProviderCredential(provider) !== undefined || this.#db.getProviderMemo(provider) !== undefined;
        } catch {
          console.warn(`[u7agent] provider memo read failed: ${provider}`);
          return this.#notStored(PROVIDER_MEMO_NOT_STORED_MESSAGE);
        }
        if (!known) throw httpError(400, PROVIDER_MEMO_TARGET_MESSAGE);
      }
      const trimmed = memo.trim();
      try {
        if (trimmed) this.#db.saveProviderMemo(provider, trimmed);
        else this.#db.deleteProviderMemo(provider);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは provider と操作の分類だけに絞る
        console.warn(`[u7agent] provider memo ${trimmed ? "save" : "delete"} failed: ${provider}`);
        return this.#notStored(PROVIDER_MEMO_NOT_STORED_MESSAGE);
      }
      // SDK と公開 state に触れないため refreshModelState() も health / カタログの再取得も行わない
      try {
        return { status: 200, response: { ...this.settings(), state: "applied" } };
      } catch {
        // 保存は確定している。一覧を組めない応答でも applied を返し、次の GET で追随させる
        return {
          status: 200,
          response: {
            ...this.#compose([], this.#memosOrEmpty(), this.#selectionOrUnset(), this.#customRowsOrEmpty()),
            state: "applied",
          },
        };
      }
    });
  }

  /** APIキーの登録 (既存は上書き)。DB を先に確定し、SDK の反映失敗は degraded として返す */
  async putKey(provider: string, apiKey: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      this.#assertNotCustomProvider(provider, CUSTOM_PROVIDER_KEY_TARGET_MESSAGE);
      if (!this.#runtime) return this.#runtimeUnavailable();
      const entry = this.#runtime.list().find((candidate) => candidate.provider === provider);
      if (!entry?.canSetApiKey) throw httpError(400, PROVIDER_KEY_TARGET_MESSAGE);
      // マスカーへの登録は SDK / DB より前。ここが失敗しても保護対象だけは残す
      this.#retainSecret(apiKey);
      let secret: StoredAppSecret;
      try {
        secret = this.#requireCipher().encrypt("provider_credentials", provider, apiKey);
      } catch {
        // master key 未設定 / 不正では平文で保存しない。何も変えずに not_stored を返す
        console.warn(`[u7agent] provider key encryption failed: ${provider}`);
        return this.#notStored(APP_SECRET_NOT_STORED_MESSAGE);
      }
      try {
        // 保存日時は DB を持つ (最終使用は保存しない)。projects.createdAt と同じく呼び出し側で作る
        this.#db.saveProviderCredential(provider, secret, Date.now());
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは provider と操作の分類だけに絞る
        console.warn(`[u7agent] provider key save failed: ${provider}`);
        return this.#notStored();
      }
      this.#secretStates.set(provider, appSecretAvailable());
      const commit = await applyWithRetry(() =>
        this.#runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      return this.#settle(provider, commit, "apply");
    });
  }

  /** この画面で登録したキーの削除。行が無ければ 400 (この画面の管理外は触らない) */
  async deleteKey(provider: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      this.#assertNotCustomProvider(provider, CUSTOM_PROVIDER_KEY_TARGET_MESSAGE);
      if (!this.#runtime) return this.#runtimeUnavailable();
      let row: ProviderCredentialRow | undefined;
      try {
        row = this.#db.getProviderCredential(provider);
      } catch {
        console.warn(`[u7agent] provider credential read failed: ${provider}`);
        return this.#notStored();
      }
      if (!row) throw httpError(400, PROVIDER_KEY_NOT_MANAGED_MESSAGE);
      try {
        this.#db.deleteProviderCredential(provider);
      } catch {
        console.warn(`[u7agent] provider key delete failed: ${provider}`);
        return this.#notStored();
      }
      // 復号は不要 (暗号文を読まない)。キャッシュは「未保存」へ戻す
      this.#secretStates.delete(provider);
      const commit = await applyWithRetry(() =>
        this.#runtime!.removeApiKey(provider, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      return this.#settle(provider, commit, "remove");
    });
  }

  /**
   * カスタムプロバイダーの作成。入力検証 → 暗号化 → DB 確定 → SDK 反映の順で行い、
   * SDK の失敗は DB を戻さず degraded (保存済み・未反映) として 200 で返す。
   */
  async createCustomProvider(input: CustomProviderInput): Promise<CustomProviderOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
      const definition = parseCustomProviderInput(input);
      assertCustomProviderIdAvailable(definition.id, this.#takenProviderIds());
      this.#assertNoStoredProviderRows(definition.id);
      // マスカーへの登録は SDK / DB / ログより先。ここが失敗しても保護対象だけは残す
      this.#retainSecret(definition.apiKey);
      let row: CustomProviderRow;
      try {
        row = customProviderRowOf(
          definition,
          this.#requireCipher().encrypt("custom_providers", definition.id, definition.apiKey),
        );
      } catch {
        // master key 未設定 / 不正では平文で保存しない。何も変えずに not_stored を返す
        console.warn(`[u7agent] custom provider key encryption failed: ${definition.id}`);
        return this.#notStored(APP_SECRET_NOT_STORED_MESSAGE);
      }
      try {
        this.#db.saveCustomProvider(row);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn(`[u7agent] custom provider save failed: ${definition.id}`);
        return this.#notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      const synced = await this.#applyCustomDefinition(definition, { needsKey: true, apiKey: definition.apiKey });
      await this.#refresh();
      return this.#customOutcome(synced, row);
    });
  }

  /**
   * カスタムプロバイダーの更新。id は変更不可、キーの空欄は既存の暗号文の維持。
   * 定義の置き換えとキーの再適用は別の失敗単位で、どちらも DB 確定後の失敗は 200 `applied_unsynced` にする。
   */
  async updateCustomProvider(provider: string, input: CustomProviderUpdateInput): Promise<CustomProviderOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
      let row: CustomProviderRow | undefined;
      try {
        row = this.#db.getCustomProvider(provider);
      } catch {
        console.warn(`[u7agent] custom provider read failed: ${provider}`);
        return this.#notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      if (!row) throw httpError(400, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
      const typedKey =
        input.apiKey === undefined || input.apiKey === "" ? undefined : parseCustomProviderApiKey(input.apiKey);
      // 現在のキーは、新しく入力されたキーとの比較にだけ使う (変換した値は保存しない)
      const storedKey = typedKey === undefined ? undefined : this.#decryptCustomKey(row).apiKey;
      const current: CustomProviderDefinition = {
        id: row.provider,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKey: storedKey ?? "",
        model: { id: row.modelId, contextWindow: row.contextWindow, maxTokens: row.maxTokens },
      };
      const next = parseCustomProviderUpdate(input, current);
      assertCustomProviderIdAvailable(next.id, this.#takenProviderIds(), current.id);
      if (typedKey !== undefined) this.#retainSecret(typedKey);
      let stored: CustomProviderRow;
      try {
        const secret =
          typedKey === undefined
            ? { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion }
            : this.#requireCipher().encrypt("custom_providers", next.id, typedKey);
        stored = customProviderRowOf({ ...next, apiKey: typedKey ?? "" }, secret);
      } catch {
        console.warn(`[u7agent] custom provider key encryption failed: ${provider}`);
        return this.#notStored(APP_SECRET_NOT_STORED_MESSAGE);
      }
      try {
        this.#db.saveCustomProvider(stored);
      } catch {
        console.warn(`[u7agent] custom provider save failed: ${provider}`);
        return this.#notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      // キーの適用は「変わったとき」か「まだ反映できていないとき」だけ。同しキーの再適用で無駄に待たせない
      const needsKey =
        (typedKey !== undefined && typedKey !== storedKey) ||
        !this.#customRegistered.has(provider) ||
        this.#degraded.get(provider) === "apply";
      const synced = await this.#applyCustomDefinition(next, {
        needsKey,
        row: stored,
        apiKey: typedKey,
      });
      await this.#refresh();
      return this.#customOutcome(synced, stored);
    });
  }

  /**
   * カスタムプロバイダーの削除。DB を先に消し、SDK は overlay (キー) → 登録の順に外す。
   * 後始末に失敗したら行は戻さず、削除待ちの tombstone をメモリに残して degraded `remove` にする。
   */
  async deleteCustomProvider(provider: string): Promise<CustomProviderOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
      let row: CustomProviderRow | undefined;
      try {
        row = this.#db.getCustomProvider(provider);
      } catch {
        console.warn(`[u7agent] custom provider read failed: ${provider}`);
        return this.#notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      if (!row) throw httpError(400, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
      const tombstone: CustomProviderSummarySource = {
        id: row.provider,
        name: row.name,
        baseUrl: row.baseUrl,
        model: { id: row.modelId, contextWindow: row.contextWindow, maxTokens: row.maxTokens },
      };
      try {
        this.#db.deleteCustomProvider(provider);
      } catch {
        console.warn(`[u7agent] custom provider delete failed: ${provider}`);
        return this.#notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      const synced = await this.#removeCustomDefinition(provider);
      if (synced) {
        this.#tombstones.delete(provider);
        this.#clearCustomDegraded(provider);
      } else {
        this.#tombstones.set(provider, tombstone);
        this.#markCustomDegraded(provider, undefined, "remove");
      }
      await this.#refresh();
      return this.#customOutcome(synced);
    });
  }

  /**
   * カスタムプロバイダーの `/models` を 1 回だけ叩いて、接続の分類と選べるモデル ID を返す。
   * 状態を変えないのでミューテーションロックを取らず、DB も書かない。master key 未設定 / 復号失敗は
   * 保存を変えないので 503 で閉じる。保存済みキーは応答に載せない。
   */
  async probeCustomProvider(input: {
    provider?: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<CustomProviderProbeResponse> {
    const typed =
      input.apiKey === undefined || input.apiKey === "" ? undefined : parseCustomProviderApiKey(input.apiKey);
    let storedKey: string | undefined;
    if (input.provider !== undefined) {
      let row: CustomProviderRow | undefined;
      try {
        row = this.#db.getCustomProvider(input.provider);
      } catch {
        console.warn(`[u7agent] custom provider read failed: ${input.provider}`);
        throw httpError(503, CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      if (!row) throw httpError(400, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
      if (typed === undefined) {
        const stored = this.#decryptCustomKey(row);
        if (stored.apiKey === null)
          throw httpError(503, stored.state.keyErrorMessage ?? APP_SECRET_DECRYPT_FAILED_MESSAGE);
        storedKey = stored.apiKey;
      }
    }
    const apiKey = typed ?? storedKey;
    if (apiKey === undefined) throw httpError(400, CUSTOM_PROVIDER_API_KEY_MESSAGE);
    if (typed !== undefined) this.#retainSecret(typed);
    return probeCustomProviderModels(
      { baseUrl: input.baseUrl, apiKey },
      {
        ...(this.#probeFetch === undefined ? {} : { fetchImpl: this.#probeFetch }),
        timeoutMs: this.#probeTimeoutMs,
      },
    );
  }

  /**
   * degraded の回復。DB の希望状態を SDK へ再適用するだけで、冪等。
   * カスタム provider は DB 行 → 削除待ち tombstone → 通常の provider_credentials の順で対象を決める
   * (行と tombstone が同じ id に併存する異常状態では行を優先する)。
   */
  async resync(provider: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable();
      let customRow: CustomProviderRow | undefined;
      try {
        customRow = this.#db.getCustomProvider(provider);
      } catch {
        console.warn(`[u7agent] custom provider read failed: ${provider}`);
        return this.#notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
      }
      if (customRow) {
        const synced = await this.#resyncCustomRow(customRow);
        await this.#refresh();
        return this.#customSettled(provider, synced, customRow);
      }
      const tombstone = this.#tombstones.get(provider);
      if (tombstone) {
        const synced = await this.#removeCustomDefinition(provider);
        if (synced) {
          this.#tombstones.delete(provider);
          this.#clearCustomDegraded(provider);
        } else {
          this.#markCustomDegraded(provider, undefined, "remove");
        }
        await this.#refresh();
        return this.#customSettled(provider, synced);
      }
      const inCatalog = this.#runtime.list().some((entry) => entry.provider === provider);
      if (!inCatalog && this.#degraded.get(provider) !== "remove") {
        throw httpError(400, PROVIDER_RESYNC_TARGET_MESSAGE);
      }
      let row: ProviderCredentialRow | undefined;
      try {
        row = this.#db.getProviderCredential(provider);
      } catch {
        console.warn(`[u7agent] provider credential read failed: ${provider}`);
        return this.#notStored();
      }
      if (row) {
        // 再同期は復号を評価し直す機会でもある (GET は復号しない)
        const { apiKey } = this.#decryptRow(row);
        if (!apiKey) {
          this.#degraded.set(provider, "apply");

          return this.#appliedUnsynced(provider, "apply");
        }
        const commit = await applyWithRetry(() =>
          this.#runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
        );
        return this.#settle(provider, commit, "apply");
      }
      const commit = await applyWithRetry(() =>
        this.#runtime!.removeApiKey(provider, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      return this.#settle(provider, commit, "remove");
    });
  }

  /**
   * DB の希望状態 (provider_credentials の行) を SDK へ写し直す。OAuth のサインアウトは SDK が
   * auth.json の資格情報と一緒に同じ provider の runtime overlay も消すため、公開 state の再計算前にここで戻す。
   * 行が無ければ何もしない。読取の失敗・反映の失敗は例外を出さず、既存の未反映 (degraded = apply) として残す。
   */
  async reapplyStoredKey(provider: string): Promise<void> {
    await this.#lock.run(async () => {
      if (!this.#runtime) return;
      let row: ProviderCredentialRow | undefined;
      try {
        row = this.#db.getProviderCredential(provider);
      } catch {
        // 戻すべきキーがあるかを判断できない。SDK はすでに runtime overlay を消しているため、実効を失ったまま
        // 黙って抜けず、既存の未反映として残す (画面の [再同期] から回復できるようにする)
        console.warn(`[u7agent] provider credential read failed: ${provider}`);
        this.#degraded.set(provider, "apply");
        return;
      }
      if (!row) return;
      const { apiKey } = this.#decryptRow(row);
      if (!apiKey) {
        this.#degraded.set(provider, "apply");
        return;
      }
      const commit = await applyWithRetry(() =>
        this.#runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      if (commitSucceeded(commit)) this.#degraded.delete(provider);
      else this.#degraded.set(provider, "apply");
    });
  }

  /**
   * カタログの手動更新。キー変更と同じロックを通し、取得できなくても一覧は現在値のまま 200 で返す
   * (失敗は `catalogError` にだけ載せる)。応答は `GET /api/runtime/models` + `catalogError`。
   */
  async refreshCatalog(): Promise<CatalogRefreshOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable(RUNTIME_MODELS_UNAVAILABLE_MESSAGE);
      // 取得と再計算で 1 つの期限を共有する。再計算も SDK の読み取りなので、切れたら現在の一覧を保って閉じる
      const signal = AbortSignal.timeout(this.#catalogTimeoutMs);
      const attempted = await this.#refreshCatalog(this.#runtime, signal);
      await this.#refresh(signal);
      const snapshot = this.#runtime.catalogSnapshot();
      // スナップショットが無い = 一覧そのものを返せない。取得試行の失敗は混ぜず、GET と同じ 503 にする
      if (!snapshot) return { status: 503, error: RUNTIME_MODELS_UNAVAILABLE_MESSAGE };
      // 再計算中に切れた場合は、取得が成功していても一覧を確定できていないためタイムアウトとして返す
      const catalogError = signal.aborted ? MODEL_CATALOG_ERROR_TIMEOUT : attempted;
      return { status: 200, response: { ...snapshot, catalogError } };
    });
  }

  /**
   * カタログ取得を 1 回だけ試し、失敗を固定文言へ寄せる。offline は SDK へ allowNetwork: true を
   * 渡す前にここで止める (渡すと SDK の offline 意思を上書きしてしまう)。
   */
  async #refreshCatalog(runtime: ProviderKeyRuntime, signal: AbortSignal): Promise<string | null> {
    if (process.env.PI_OFFLINE !== undefined) return MODEL_CATALOG_ERROR_OFFLINE;
    let attempt: ModelCatalogRefreshAttempt;
    try {
      attempt = await runtime.refreshCatalog({ allowNetwork: true, force: true, signal });
    } catch (error) {
      // 生の文言は応答へ出さず、マスカーを通した分類だけをログへ残す
      console.warn(`[u7agent] model catalog refresh failed: ${this.#maskError(messageFor(error))}`);
      return MODEL_CATALOG_ERROR_UNKNOWN;
    }
    // abort (期限) は provider の失敗と同時でも「取得できなかった」主体は期限側なので、こちらを優先する
    if (attempt.aborted) return MODEL_CATALOG_ERROR_TIMEOUT;
    if (attempt.failedProviders > 0) {
      // provider id も生の文言も出さない。件数だけを分類として残す
      console.warn(`[u7agent] model catalog refresh incomplete: ${attempt.failedProviders} provider(s)`);
      return MODEL_CATALOG_ERROR_PARTIAL;
    }
    return null;
  }

  /** 成功・失敗のどちらでも再計算を 1 回だけ公開し、degraded を更新して応答を組む */
  async #settle(provider: string, commit: CredentialCommit, operation: "apply" | "remove"): Promise<MutationOutcome> {
    await this.#refresh();
    const succeeded = commitSucceeded(commit);
    if (succeeded) this.#degraded.delete(provider);
    else this.#degraded.set(provider, operation);
    try {
      return { status: 200, response: { ...this.settings(), state: succeeded ? "applied" : "applied_unsynced" } };
    } catch {
      return this.#appliedUnsynced(provider, operation);
    }
  }

  /**
   * DTO を組めない / 復号できないときに、変更を not_stored と言わず未同期として回復導線を残す。
   * managed (= DB に行がある) を補えるのは apply だけ。remove は削除が確定済みなので補わない。
   */
  #appliedUnsynced(provider: string, operation: "apply" | "remove", known?: CustomProviderRow): MutationOutcome {
    this.#degraded.set(provider, operation);
    const assumedManaged = operation === "apply" && known === undefined ? provider : undefined;
    return {
      status: 200,
      response: {
        ...this.#compose(
          [],
          this.#memosOrEmpty(),
          this.#selectionOrUnset(),
          this.#customRowsOrEmpty(known),
          assumedManaged,
        ),
        state: "applied_unsynced",
      },
    };
  }

  /** refresh は例外を出さない契約だが、実装差で lock を壊さないようここでも囲む */
  async #refresh(signal?: AbortSignal): Promise<void> {
    try {
      await this.#refreshModelState(signal ? { signal } : undefined);
    } catch (error) {
      console.warn(`[u7agent] model state refresh failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  #notStored(error: string = PROVIDER_KEY_NOT_STORED_MESSAGE): { status: 503; error: string } {
    return { status: 503, error };
  }

  /**
   * カスタムプロバイダーの変更応答。一覧を組めないときも変更は確定しているため、
   * `applied` / `applied_unsynced` を保って GET と同じ形で返し、次の GET に追随させる。
   * `known` はこの操作で確定した行で、一覧を読めないときも応答から落とさない
   * (空配列を返すとクライアントが一覧を置き換え、編集・削除・再同期の導線が消える)。
   */
  #customOutcome(synced: boolean, known?: CustomProviderRow): CustomProviderOutcome {
    const state = synced ? "applied" : "applied_unsynced";
    try {
      return { status: 200, response: { ...this.settings(), state } };
    } catch {
      return {
        status: 200,
        response: {
          ...this.#compose([], this.#memosOrEmpty(), this.#selectionOrUnset(), this.#customRowsOrEmpty(known)),
          state,
        },
      };
    }
  }

  /** カスタムの再同期の応答。一覧を組めないときも `state` を保ち、対象の行を落とさない */
  #customSettled(provider: string, synced: boolean, known?: CustomProviderRow): MutationOutcome {
    if (!synced) return this.#appliedUnsynced(provider, this.#degraded.get(provider) ?? "apply", known);
    try {
      return { status: 200, response: { ...this.settings(), state: "applied" } };
    } catch {
      return {
        status: 200,
        response: {
          ...this.#compose([], this.#memosOrEmpty(), this.#selectionOrUnset(), this.#customRowsOrEmpty(known)),
          state: "applied",
        },
      };
    }
  }

  /**
   * 一覧のフォールバック用。読めないときは空で縮退し、次の GET の 503 で気付けるようにする。
   * `known` を渡すと、その行だけは読取失敗に巻き込まずに応答へ残す。
   */
  #customRowsOrEmpty(known?: CustomProviderRow): CustomProviderRow[] {
    try {
      return this.#db.listCustomProviders();
    } catch {
      return known ? [known] : [];
    }
  }

  /** 登録済み (runtime) / DB 行 / 削除待ち tombstone の id。衝突判定の入力 */
  #takenProviderIds(): string[] {
    const ids = new Set(this.#runtime?.list().map((entry) => entry.provider) ?? []);
    for (const id of this.#tombstones.keys()) ids.add(id);
    let rows: CustomProviderRow[];
    try {
      rows = this.#db.listCustomProviders();
    } catch {
      console.warn("[u7agent] custom provider ids read failed");
      throw httpError(503, CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE);
    }
    for (const row of rows) ids.add(row.provider);
    return [...ids];
  }

  /**
   * 孤立した provider_credentials / provider_memos の行がある id では作らない。行があると DTO が
   * managed: true / keyUpdatedAt 非 null になり、カスタム画面からその行を削除できなくなる。
   */
  #assertNoStoredProviderRows(provider: string): void {
    let stored: boolean;
    try {
      stored =
        this.#db.getProviderCredential(provider) !== undefined || this.#db.getProviderMemo(provider) !== undefined;
    } catch {
      console.warn(`[u7agent] provider stored rows read failed: ${provider}`);
      throw httpError(503, CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE);
    }
    if (stored) throw httpError(400, CUSTOM_PROVIDER_STORED_ROWS_MESSAGE);
  }

  /**
   * カスタムプロバイダーのキー・メモは専用の API だけで扱う。削除待ち tombstone の id も予約済みとして
   * 拒否し、後始末が終わるまで同じ id の行を作らせない。
   */
  #assertNotCustomProvider(provider: string, error: string): void {
    if (this.#tombstones.has(provider)) throw httpError(400, error);
    let row: CustomProviderRow | undefined;
    try {
      row = this.#db.getCustomProvider(provider);
    } catch {
      console.warn(`[u7agent] custom provider read failed: ${provider}`);
      throw httpError(503, CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE);
    }
    if (row) throw httpError(400, error);
  }

  /**
   * SDK へ登録する。成功したときだけ「このプロセスが所有する ID」に加え、失敗しても throw しない
   * (呼び出し側が degraded に倒す)。SDK の例外文言は URL や provider 名を含み得るのでログにも残さない。
   */
  #registerCustom(definition: CustomProviderDefinition): boolean {
    try {
      this.#runtime!.registerProvider(definition.id, customProviderRuntimeConfig(definition));
    } catch {
      console.warn(`[u7agent] custom provider register failed: ${definition.id}`);
      return false;
    }
    this.#customRegistered.add(definition.id);
    return true;
  }

  /**
   * 定義を SDK へ写してキーまで適用する。所有境界 (このプロセスで register した ID だけを触る) を通し、
   * built-in / models.json と同じ id には register もキー適用もしない。
   * `row` / `apiKey` を渡すと保存済みの暗号文を復号し直さずにその値を使う。
   */
  async #applyCustomDefinition(
    definition: CustomProviderDefinition,
    options: { needsKey: boolean; row?: CustomProviderRow; apiKey?: string } = { needsKey: true },
  ): Promise<boolean> {
    const runtimeHas = this.#runtime!.list().some((entry) => entry.provider === definition.id);
    if (!this.#customRegistered.has(definition.id) && runtimeHas) {
      this.#markCustomDegraded(definition.id, CUSTOM_PROVIDER_ID_CONFLICT_DEGRADED_MESSAGE);
      return false;
    }
    if (!this.#registerCustom(definition)) {
      this.#markCustomDegraded(definition.id, CUSTOM_PROVIDER_ID_CONFLICT_DEGRADED_MESSAGE);
      return false;
    }
    if (!options.needsKey) {
      this.#clearCustomDegraded(definition.id);
      return true;
    }
    let apiKey = options.apiKey;
    if (apiKey === undefined) {
      const stored = options.row === undefined ? undefined : this.#decryptCustomKey(options.row).apiKey;
      if (stored === null || stored === undefined) {
        this.#markCustomDegraded(definition.id);
        return false;
      }
      apiKey = stored;
    }
    const commit = await this.#applyCustomKey(definition.id, apiKey);
    if (!commitSucceeded(commit)) {
      this.#markCustomDegraded(definition.id);
      return false;
    }
    this.#clearCustomDegraded(definition.id);
    return true;
  }

  /**
   * 削除の後始末。overlay (キー) → 登録の順で外す (逆順だと同し id の再登録で古いキーが復活する)。
   * 登録していない id には SDK を触らず、built-in / models.json の runtime entry を消さない。
   */
  async #removeCustomDefinition(provider: string): Promise<boolean> {
    if (!this.#customRegistered.has(provider)) return true;
    const removed = await this.#removeCustomKey(provider);
    if (!commitSucceeded(removed)) {
      console.warn(`[u7agent] custom provider key remove deferred: ${provider} (${removed.outcome})`);
      return false;
    }
    try {
      this.#runtime!.unregisterProvider(provider);
    } catch {
      // overlay は消えているが登録は残る。再同期で同じ手順を繰り返せるよう未反映として残す
      console.warn(`[u7agent] custom provider unregister failed: ${provider}`);
      return false;
    }
    this.#customRegistered.delete(provider);
    return true;
  }

  /** 保存済みの DB 行を SDK へ写し直す (再同期)。成功したら degraded / tombstone を解除する */
  async #resyncCustomRow(row: CustomProviderRow): Promise<boolean> {
    const { apiKey, state } = this.#decryptCustomKey(row);
    if (apiKey === null) {
      this.#markCustomDegraded(row.provider, state.keyErrorMessage);
      return false;
    }
    let definition: CustomProviderDefinition;
    try {
      definition = storedCustomProviderDefinition(row, apiKey);
    } catch {
      this.#markCustomDegraded(row.provider, CUSTOM_PROVIDER_INVALID_STORED_MESSAGE);
      return false;
    }
    const synced = await this.#applyCustomDefinition(definition, { needsKey: true, apiKey });
    if (synced) this.#tombstones.delete(row.provider);
    return synced;
  }

  async #applyCustomKey(provider: string, apiKey: string): Promise<CredentialCommit> {
    try {
      return await applyWithRetry(() =>
        this.#runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
    } catch {
      return { outcome: "unknown" };
    }
  }

  async #removeCustomKey(provider: string): Promise<CredentialCommit> {
    try {
      return await applyWithRetry(() =>
        this.#runtime!.removeApiKey(provider, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
    } catch {
      return { outcome: "unknown" };
    }
  }

  /** degraded の記録。`message` を渡したときだけ原因の固定文言を差し替え、省略時は既存を保つ */
  #markCustomDegraded(provider: string, message?: string | null, operation: "apply" | "remove" = "apply"): void {
    this.#degraded.set(provider, operation);
    if (message) this.#degradedMessages.set(provider, message);
  }

  #clearCustomDegraded(provider: string): void {
    this.#degraded.delete(provider);
    this.#degradedMessages.delete(provider);
  }

  #runtimeUnavailable(error: string = PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE): { status: 503; error: string } {
    return this.#notStored(error);
  }

  #requireCipher(): AppSecretCipher {
    if (!this.#appCipher) throw new Error(APP_SECRET_NOT_STORED_MESSAGE);
    return this.#appCipher;
  }

  /**
   * 保存行を復号し、結果をメモリのキャッシュへ残す。復号した値は SDK へ渡す前に保護対象へ入れる。
   * 平文へは落とさず、失敗は固定文言の状態として返す。
   */
  #decryptRow(row: ProviderCredentialRow): { apiKey: string | null; state: AppSecretState } {
    if (!this.#appCipher) {
      const state = appSecretMasterKeyMissing();
      this.#secretStates.set(row.provider, state);
      return { apiKey: null, state };
    }
    try {
      const apiKey = this.#appCipher.decrypt("provider_credentials", row.provider, row);
      this.#retainSecret(apiKey);
      const state = appSecretAvailable();
      this.#secretStates.set(row.provider, state);
      return { apiKey, state };
    } catch {
      const state = appSecretFailed();
      this.#secretStates.set(row.provider, state);
      return { apiKey: null, state };
    }
  }

  /**
   * カスタム provider の保存行の復号。GET とは別で、SDK へ渡す直前と probe / 再同期のときだけ呼ぶ。
   * 復号した値は返す前に保護対象へ入れ、平文へは落とさない。
   */
  #decryptCustomKey(row: CustomProviderRow): { apiKey: string | null; state: AppSecretState } {
    if (!this.#appCipher) return { apiKey: null, state: appSecretMasterKeyMissing() };
    try {
      const apiKey = this.#appCipher.decrypt("custom_providers", row.provider, row);
      this.#retainSecret(apiKey);
      return { apiKey, state: appSecretAvailable() };
    } catch {
      return { apiKey: null, state: appSecretFailed() };
    }
  }

  /** 保存値の読取。行が無ければ未設定 (制限なし・既定なし) */
  #readSelection(): StoredModelSelection {
    const row = this.#db.readModelSettings();
    return { allowedModels: row?.allowedModels ?? null, defaultModel: row?.defaultModel ?? null };
  }

  /** メモ一覧の読取。組めないときは空で縮退し、次の GET の 503 で気付けるようにする */
  #memosOrEmpty(): ProviderMemoRow[] {
    try {
      return this.#db.listProviderMemos();
    } catch {
      return [];
    }
  }

  /** provider 変更の応答を組むときの補正。読めない側は未設定で組み、次の GET の 503 で気付けるようにする */
  #selectionOrUnset(): StoredModelSelection {
    try {
      return this.#readSelection();
    } catch {
      return { allowedModels: null, defaultModel: null };
    }
  }

  /**
   * GET / 変更系の応答 DTO。rows は DB の生きた行で、`managed` はこの行の有無だけで決める。
   * memos は provider に紐づく人間用メモで、行がある provider は credential / カタログに無くても
   * orphan として出す (managed は false のままで、バッジは既存の「カタログ外」に落ちる)。
   * `assumedManaged` は一覧を読めず rows が空のときだけ渡せる「行があると確定している」provider の補正で、
   * 呼び出し側が書込/読取の成功で保証できる apply のときだけ使う (DELETE では渡さない)。
   * customRows は `custom_providers` の生きた行で、一覧 (`customProviders[]`) の正はこちらだけにする。
   * 同じ id の `provider_credentials` / `provider_memos` は DB に残っていても DTO へ混ぜない
   * (カスタム側が正で、通常行の `managed` / メモを持たせると同じ id の管理状態が二重になる)。
   */
  #compose(
    rows: ProviderCredentialRow[],
    memos: ProviderMemoRow[],
    selection: StoredModelSelection,
    customRows: CustomProviderRow[],
    assumedManaged?: string,
  ): ModelsSettingsResponse {
    const customRowIds = new Set(customRows.map((row) => row.provider));
    const credentialRows = rows.filter((row) => !customRowIds.has(row.provider));
    const memoRows = memos.filter((row) => !customRowIds.has(row.provider));
    const managed = new Set(credentialRows.map((row) => row.provider));
    if (assumedManaged) managed.add(assumedManaged);
    const memoOf = new Map(memoRows.map((row) => [row.provider, row.memo]));
    const updatedAtOf = new Map(credentialRows.map((row) => [row.provider, row.updatedAt]));
    // 行が無い (= managed でない) provider は保存日時も不明として null にする
    const keyUpdatedAtOf = (provider: string): number | null =>
      managed.has(provider) ? (updatedAtOf.get(provider) ?? null) : null;
    const providers = new Map<string, ProviderAuthSetting>();
    const customIds = new Set(this.#customRegistered);
    // 行があるのにキャッシュに無い provider は「保存済みだが復号をまだ確認していない」= 未評価
    const keyStateOf = (provider: string): AppSecretState =>
      managed.has(provider) ? (this.#secretStates.get(provider) ?? appSecretUnevaluated()) : appSecretNotStored();
    for (const entry of this.#runtime?.list() ?? []) {
      providers.set(
        entry.provider,
        this.#settingOf(
          entry.provider,
          entry.name,
          this.#runtime?.auth(entry.provider),
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
        this.#settingOf(
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
        this.#settingOf(
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
    for (const provider of this.#degraded.keys()) {
      if (customRowIds.has(provider) || this.#tombstones.has(provider)) continue;
      if (providers.has(provider)) continue;
      providers.set(
        provider,
        this.#settingOf(
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
      runtimeAvailable: this.#runtime !== null,
      // 応答は "provider/model" の一覧にする (DB 行は ModelRef の JSON 配列)
      allowedModels: selection.allowedModels?.map(labelOf) ?? null,
      defaultModel: selection.defaultModel,
      ignoredEnvironmentVariables: this.#ignoredEnvironmentVariables,
      providers: [...providers.values()],
      customProviders: this.#customSummaries(customRows),
    };
  }

  /**
   * カスタムプロバイダーの一覧。順序は DB 行の追加順で、削除待ち tombstone は行の無いものだけを
   * 末尾に足す (未反映のまま画面から漏れないようにする)。GET は復号しないので、hasKey は暗号文の有無で決める。
   */
  #customSummaries(rows: CustomProviderRow[]): CustomProviderSummary[] {
    const listed = new Set(rows.map((row) => row.provider));
    const summaries = rows.map((row) => this.#customSummaryOf(row));
    for (const [id, tombstone] of this.#tombstones) {
      if (listed.has(id)) continue;
      summaries.push(customProviderSummary(tombstone, { hasKey: false, degraded: "remove" }));
    }
    return summaries;
  }

  #customSummaryOf(row: CustomProviderRow): CustomProviderSummary {
    // runtime の無い構成は保存内容だけを返す (反映済み / 未反映の区別はランタイム警告に任せる)
    if (!this.#runtime) return customProviderSummaryOfRow(row);
    return customProviderSummaryOfRow(row, {
      degraded: this.#degraded.get(row.provider),
      degradedMessage: this.#degradedMessages.get(row.provider) ?? null,
    });
  }

  #settingOf(
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
  ): ProviderAuthSetting {
    const degraded =
      flags.orphan && flags.appliable && !this.#degraded.has(provider) ? "apply" : this.#degraded.get(provider);
    const sanitized: RuntimeAuth = sanitizeRuntimeAuth(auth);
    return {
      provider,
      name,
      auth: sanitized,
      managed: flags.managed,
      canSetApiKey: flags.canSetApiKey,
      supportsOAuth: flags.supportsOAuth,
      canSignInHere: flags.canSignInHere,
      credentialKind: this.#credentialKindOf(provider, sanitized),
      oauthLoginLabel,
      // カスタムプロバイダーは auth.json の OAuth を持たないので、表示専用の読取も行わない
      hiddenStoredOAuth: sanitized.source === "runtime" && !custom && this.#storedOAuthHidden(provider),
      orphan: flags.orphan,
      ...(custom ? { custom: true } : {}),
      login: this.#oauthLogin?.stateOf(provider) ?? null,
      ...(degraded ? { degraded } : {}),
      memo: memo ?? null,
      keyUpdatedAt,
      keyAvailable: flags.managed && secretState.keyAvailable,
      keyEvaluated: flags.managed ? secretState.keyEvaluated : true,
      keyErrorMessage: flags.managed ? secretState.keyErrorMessage : null,
    };
  }

  /** SDK が見ている種別。認証なしの provider には聞かない (unconfigured では種別が無い) */
  #credentialKindOf(provider: string, auth: RuntimeAuth): CredentialKind | null {
    if (!auth.configured) return null;
    return this.#runtime?.credentialKind(provider) ?? null;
  }

  /**
   * この画面のキーが auth.json の OAuth を覆っているか。表示専用の auth.json 読取で、失敗は
   * 「不明」として false へ縮退させ、設定 API を読取の失敗で落とさない。
   */
  #storedOAuthHidden(provider: string): boolean {
    try {
      return this.#runtime?.storedCredentialKind(provider) === "oauth";
    } catch {
      return false;
    }
  }
}
