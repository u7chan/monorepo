/**
 * 設定 → モデル (プロバイダーAPIキー・メモ・利用可能なモデル・カタログ) のサービス。
 * アプリ DB を希望状態の正として先に確定し、SDK の runtime overlay へ写す。写しに失敗しても DB は戻さず、
 * degraded (保存済み・未反映) として記録して resync / 次回変更 / 再起動で収束させる (補償ロールバックは持たない)。
 * カスタムプロバイダーの手順は custom-provider-settings.ts、応答 DTO の組み立ては model-settings-response.ts。
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
  APP_SECRET_NOT_STORED_MESSAGE,
  appSecretAvailable,
  evaluateAppSecret,
  requireAppSecretCipher,
  type AppSecretState,
} from "./app-secrets";
import type { ModelCatalogRefreshAttempt } from "./model-state";
import { CUSTOM_PROVIDER_KEY_TARGET_MESSAGE, CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE } from "./custom-providers";
import type { CustomProviderInput, CustomProviderRuntimeConfig, CustomProviderUpdateInput } from "./custom-providers";
import { CUSTOM_PROVIDER_PROBE_TIMEOUT_MS } from "./custom-provider-probe";
import { CustomProviderSettings, type CustomProviderOutcome } from "./custom-provider-settings";
import { httpError, messageFor } from "./http";
import { formatModelRef, modelKey, parseModelRef } from "./model-ref";
import { composeModelSettingsResponse, type ModelSettingsRuntimeView } from "./model-settings-response";
import type { AppSecretCipher } from "./secret-crypto";
import { SerialLock } from "./serial-lock";
import {
  PROVIDER_API_KEY_MIN_LENGTH,
  RUNTIME_MODELS_UNAVAILABLE_MESSAGE,
  type CustomProviderProbeResponse,
  type ModelCatalogRefreshResponse,
  type ModelRef,
  type ModelsSettingsResponse,
  type ModelMutationResponse,
  type OAuthLoginState,
  type RuntimeModelsResponse,
} from "./schema";

/** SDK 操作の結果。CSE は「commit 済み・同期失敗」、unknown は commit の有無を断定しない。 */
export type CredentialCommit =
  | { outcome: "applied"; synced: true }
  | { outcome: "applied"; synced: false }
  | { outcome: "not_applied" }
  | { outcome: "unknown" };

/** SDK commit と state 再計算を分離する継ぎ目。state の再導出は呼び出し側 (このサービス) が担う。 */
export interface ProviderKeyRuntime extends ModelSettingsRuntimeView {
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

/** カタログ更新の応答。503 は一覧そのものを返せないときだけで、取得失敗は 200 の `catalogError` に載せる */
export type CatalogRefreshOutcome =
  | { status: 200; response: ModelCatalogRefreshResponse }
  | { status: 503; error: string };

/** 一度目の commit が applied/synced でなければ、同じ操作を 1 回だけ再試行する (冪等) */
async function applyWithRetry(run: () => Promise<CredentialCommit>): Promise<CredentialCommit> {
  const first = await run();
  if (first.outcome === "applied" && first.synced) return first;
  return run();
}

function commitSucceeded(commit: CredentialCommit): boolean {
  return commit.outcome === "applied" && commit.synced;
}

function parseModelSelectionRef(value: string): ModelRef {
  const ref = parseModelRef(value.trim());
  const provider = ref?.provider.trim();
  const id = ref?.id.trim();
  if (!provider || !id) throw httpError(400, MODEL_SELECTION_FORMAT_MESSAGE);
  return { provider, id };
}

/** 重複を先勝ちで落とし、空配列を「制限なし」の null へ寄せる。形式の誤りは 400 */
function normalizeAllowedModels(input: string[] | null): ModelRef[] | null {
  if (!input) return null;
  const seen = new Set<string>();
  const normalized: ModelRef[] = [];
  for (const entry of input) {
    const ref = parseModelSelectionRef(entry);
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
    return parseModelSelectionRef(value);
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
  #lock = new SerialLock();
  /** このプロセスのメモリだけが持つ未反映の印。再起動で消える */
  #degraded = new Map<string, "apply" | "remove">();
  /**
   * 保存済みキーの復号結果。起動時と保存 / 置換 / 再同期のときだけ更新し、GET では復号しない。
   * 行があるのに載っていない provider は「未評価」として返す (起動時に DB を読めなかった場合)。
   */
  #secretStates = new Map<string, AppSecretState>();
  /** カスタムプロバイダーの定義・登録・degraded / tombstone。ロックと degraded の表はこのサービスと共有する */
  #custom: CustomProviderSettings;

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
    this.#custom = new CustomProviderSettings({
      db: options.db,
      runtime: options.runtime,
      appCipher: this.#appCipher,
      retainSecret: options.retainSecret,
      maskError: options.maskError,
      timeoutMs: this.#timeoutMs,
      probeTimeoutMs: this.#probeTimeoutMs,
      probeFetch: this.#probeFetch,
      degraded: this.#degraded,
      applyWithRetry,
      commitSucceeded,
      refresh: () => this.#refresh(),
      settings: () => this.settings(),
      fallbackSettings: (known) =>
        this.#compose([], this.#memosOrEmpty(), this.#selectionOrUnset(), this.#custom.rowsOrEmpty(known)),
      unsynced: (provider, operation, known) => this.#appliedUnsynced(provider, operation, known),
    });
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
      this.#custom.rows(),
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
      const customRows = await this.#custom.applyStored();
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
      const defaultModel = input.defaultModel === null ? null : parseModelSelectionRef(input.defaultModel);
      const catalog = new Map(this.#runtime.catalog().map((model) => [modelKey(model), model]));
      for (const model of allowedModels ?? []) {
        if (!catalog.has(modelKey(model))) {
          throw httpError(400, `${MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE}: ${formatModelRef(model)}`);
        }
      }
      // 選択可能なモデルは保存値で決まり、制限なしのときはカタログ全体から選べる
      const selectable = allowedModels ?? [...catalog.values()];
      if (defaultModel && !catalog.has(modelKey(defaultModel))) {
        // カタログ外は「既定が許可外」より先に、保存できない理由を具体的に返す
        throw httpError(400, `${MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE}: ${formatModelRef(defaultModel)}`);
      }
      if (defaultModel && !selectable.some((model) => modelKey(model) === modelKey(defaultModel))) {
        throw httpError(400, `${MODEL_SELECTION_DEFAULT_NOT_ALLOWED_MESSAGE}: ${formatModelRef(defaultModel)}`);
      }
      const stored: StoredModelSelection = {
        allowedModels,
        defaultModel: defaultModel ? formatModelRef(defaultModel) : null,
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
            ...this.#compose([], this.#memosOrEmpty(), stored, this.#custom.rowsOrEmpty()),
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
      this.#custom.assertNotProvider(provider, CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE);
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
            ...this.#compose([], this.#memosOrEmpty(), this.#selectionOrUnset(), this.#custom.rowsOrEmpty()),
            state: "applied",
          },
        };
      }
    });
  }

  /** APIキーの登録 (既存は上書き)。DB を先に確定し、SDK の反映失敗は degraded として返す */
  async putKey(provider: string, apiKey: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      this.#custom.assertNotProvider(provider, CUSTOM_PROVIDER_KEY_TARGET_MESSAGE);
      if (!this.#runtime) return this.#runtimeUnavailable();
      const entry = this.#runtime.list().find((candidate) => candidate.provider === provider);
      if (!entry?.canSetApiKey) throw httpError(400, PROVIDER_KEY_TARGET_MESSAGE);
      // マスカーへの登録は SDK / DB より前。ここが失敗しても保護対象だけは残す
      this.#retainSecret(apiKey);
      let secret: StoredAppSecret;
      try {
        secret = requireAppSecretCipher(this.#appCipher).encrypt("provider_credentials", provider, apiKey);
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
      this.#custom.assertNotProvider(provider, CUSTOM_PROVIDER_KEY_TARGET_MESSAGE);
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

  /** カスタムプロバイダーの作成。ロックはキー変更と同じものを使う */
  async createCustomProvider(input: CustomProviderInput): Promise<CustomProviderOutcome> {
    return this.#lock.run(() => this.#custom.create(input));
  }

  /** カスタムプロバイダーの更新。id は変更不可、キーの空欄は既存の暗号文の維持 */
  async updateCustomProvider(provider: string, input: CustomProviderUpdateInput): Promise<CustomProviderOutcome> {
    return this.#lock.run(() => this.#custom.update(provider, input));
  }

  /** カスタムプロバイダーの削除。後始末に失敗したら tombstone を残して applied_unsynced にする */
  async deleteCustomProvider(provider: string): Promise<CustomProviderOutcome> {
    return this.#lock.run(() => this.#custom.delete(provider));
  }

  /** カスタムプロバイダーの `/models` の 1 回だけの probe。状態を変えないのでロックを取らない */
  probeCustomProvider(input: {
    provider?: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<CustomProviderProbeResponse> {
    return this.#custom.probe(input);
  }

  /**
   * degraded の回復。DB の希望状態を SDK へ再適用するだけで、冪等。
   * カスタム provider は DB 行 → 削除待ち tombstone → 通常の provider_credentials の順で対象を決める
   * (行と tombstone が同じ id に併存する異常状態では行を優先する)。
   */
  async resync(provider: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable();
      const custom = await this.#custom.resync(provider);
      if (custom) return custom;
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
          this.#custom.rowsOrEmpty(known),
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

  #runtimeUnavailable(error: string = PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE): { status: 503; error: string } {
    return this.#notStored(error);
  }

  #decryptRow(row: ProviderCredentialRow): { apiKey: string | null; state: AppSecretState } {
    const { value: apiKey, state } = evaluateAppSecret({
      cipher: this.#appCipher,
      runtimeAvailable: true,
      scope: "provider_credentials",
      owner: row.provider,
      secret: row,
      retain: (value) => this.#retainSecret(value),
    });
    this.#secretStates.set(row.provider, state);
    return { apiKey, state };
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

  /** 応答 DTO。渡された行と、このサービスが持つ runtime / 未反映 / tombstone / 復号結果から組む */
  #compose(
    rows: ProviderCredentialRow[],
    memos: ProviderMemoRow[],
    selection: StoredModelSelection,
    customRows: CustomProviderRow[],
    assumedManaged?: string,
  ): ModelsSettingsResponse {
    return composeModelSettingsResponse({
      runtime: this.#runtime,
      credentialRows: rows,
      memos,
      selection,
      customRows,
      ...(assumedManaged === undefined ? {} : { assumedManaged }),
      customRegistered: this.#custom.registered,
      tombstones: this.#custom.tombstones,
      degraded: this.#degraded,
      degradedMessages: this.#custom.degradedMessages,
      secretStates: this.#secretStates,
      oauthLogin: this.#oauthLogin,
      ignoredEnvironmentVariables: this.#ignoredEnvironmentVariables,
    });
  }
}
