/**
 * 設定 → モデル (プロバイダーAPIキー) のサービス。
 * アプリ DB を希望状態の正として先に確定し、SDK の runtime overlay へ写す。写しに失敗しても DB は戻さず、
 * degraded (保存済み・未反映) として記録して resync / 次回変更 / 再起動で収束させる (補償ロールバックは持たない)。
 * 契約と残存リスクは docs/model-settings.md を正とする。
 */
import type { ModelSettingsRow, ProviderCredentialRow } from "./app-db";
import { sanitizeRuntimeAuth, type RuntimeAuthStatusLike } from "./agent";
import { httpError, messageFor } from "./http";
import {
  PROVIDER_API_KEY_MIN_LENGTH,
  type ModelRef,
  type ModelsSettingsResponse,
  type ModelMutationResponse,
  type ProviderAuthSetting,
  type RuntimeAuth,
} from "./schema";

/** SDK 操作の結果。CSE は「commit 済み・同期失敗」、unknown は commit の有無を断定しない。 */
export type CredentialCommit =
  | { outcome: "applied"; synced: true }
  | { outcome: "applied"; synced: false }
  | { outcome: "not_applied" }
  | { outcome: "unknown" };

/** SDK commit と state 再計算を分離する継ぎ目。state の再導出は呼び出し側 (このサービス) が担う。 */
export interface ProviderKeyRuntime {
  list(): { provider: string; name: string; canSetApiKey: boolean; supportsOAuth: boolean }[];
  auth(provider: string): RuntimeAuthStatusLike | undefined;
  /**
   * カタログの provider/model。保存値の検証はここを引き、認証状態に依存する `getAvailable()` へ
   * 依存させない (未認証でも許可リストには入れられる)。
   */
  catalog(): ModelRef[];
  applyApiKey(provider: string, apiKey: string, options: { signal: AbortSignal }): Promise<CredentialCommit>;
  removeApiKey(provider: string, options: { signal: AbortSignal }): Promise<CredentialCommit>;
}

export interface ModelSettingsDb {
  listProviderCredentials(): ProviderCredentialRow[];
  getProviderCredential(provider: string): ProviderCredentialRow | undefined;
  saveProviderCredential(provider: string, apiKey: string): void;
  deleteProviderCredential(provider: string): boolean;
  /** 行が無ければ undefined = 未設定 */
  readModelSettings(): ModelSettingsRow | undefined;
  saveModelSettings(settings: ModelSettingsRow): void;
}

/** 保存値としての利用可能なモデル / アプリ既定モデル。null は未設定 (制限なし・候補の先頭) */
export interface StoredModelSelection {
  allowedModels: ModelRef[] | null;
  defaultModel: string | null;
}

export interface ModelSettingsOptions {
  db: ModelSettingsDb;
  /** null = ランタイム初期化失敗。GET は runtimeAvailable: false、変更系は 503 not_stored */
  runtime: ProviderKeyRuntime | null;
  /** SDK / DB へ触る前に保護対象へ足す (マスカーの swap は同期) */
  retainSecret: (value: string) => void;
  /** health / ログへ出す前の文言境界 (可変マスカー) */
  maskError: (text: string) => string;
  /** 公開 state の再計算。例外を出さない契約 */
  refreshModelState: () => Promise<void>;
  /**
   * 保存値の適用。公開 state へ効かせるのは refreshModelState() なので、必ず setter → refresh の順に呼ぶ。
   * undefined は未設定 (制限なし・候補の先頭) を表す。
   */
  setModelSelection: (selection: { allowedModels: ModelRef[] | undefined; defaultModel: ModelRef | undefined }) => void;
  /** 残っていて無視している移行前の環境変数名。画面の注記と起動ログが同じ値を使う */
  ignoredEnvironmentVariables: string[];
  /** SDK 操作の期限。timeout は「未適用」と断定せず unknown に倒す */
  timeoutMs?: number;
}
export const PROVIDER_KEY_SYNC_TIMEOUT_MS = 20_000;

export const PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、APIキーを変更できません";
export const PROVIDER_KEY_NOT_STORED_MESSAGE = "APIキーをアプリデータ（SQLite）へ保存できませんでした";
export const PROVIDER_KEY_TARGET_MESSAGE = "このプロバイダーにはAPIキーを登録できません";
export const PROVIDER_KEY_NOT_MANAGED_MESSAGE = "この画面で登録したAPIキーがありません";
export const PROVIDER_RESYNC_TARGET_MESSAGE = "このプロバイダーは再同期できません";
export const MODEL_SELECTION_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、利用可能なモデルを変更できません";
export const MODEL_SELECTION_NOT_STORED_MESSAGE = "利用可能なモデルをアプリデータ（SQLite）へ保存できませんでした";
export const MODEL_SELECTION_FORMAT_MESSAGE = "モデルは provider/model 形式で指定してください";
export const MODEL_SELECTION_NOT_IN_CATALOG_MESSAGE = "カタログに無いモデルは指定できません";
export const MODEL_SELECTION_DEFAULT_NOT_ALLOWED_MESSAGE = "既定モデルは利用可能なモデルから選んでください";

export type MutationOutcome = { status: 200; response: ModelMutationResponse } | { status: 503; error: string };

/**
 * 認証変更・DB 書込・state 公開を直列化する 1 本のロック。
 * 前のタスクの失敗でチェーンを止めず、呼び出し側へは自分のタスクの結果だけを返す。
 */
class MutationLock {
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
  #refreshModelState: () => Promise<void>;
  #setModelSelection: ModelSettingsOptions["setModelSelection"];
  #ignoredEnvironmentVariables: string[];
  #timeoutMs: number;
  #lock = new MutationLock();
  /** このプロセスのメモリだけが持つ未反映の印。再起動で消える */
  #degraded = new Map<string, "apply" | "remove">();

  constructor(options: ModelSettingsOptions) {
    this.#db = options.db;
    this.#runtime = options.runtime;
    this.#retainSecret = options.retainSecret;
    this.#maskError = options.maskError;
    this.#refreshModelState = options.refreshModelState;
    this.#setModelSelection = options.setModelSelection;
    this.#ignoredEnvironmentVariables = options.ignoredEnvironmentVariables;
    this.#timeoutMs = options.timeoutMs ?? PROVIDER_KEY_SYNC_TIMEOUT_MS;
  }

  /** GET。純粋読取で、SDK の呼び出しも修復も行わない (DB の失敗は 503 のまま伝える) */
  settings(): ModelsSettingsResponse {
    return this.#compose(this.#db.listProviderCredentials(), this.#readSelection());
  }

  /**
   * 起動時の適用。ロック 1 回・全行の SDK 適用後に refresh 1 回。
   * provider_credentials と model_settings の読取は独立に扱い、片方が失敗しても他方の適用と最後の
   * 再計算を行う。読めなかったときは空 DB として黙って続行しない (警告だけ出し、設定 API は 503 のまま)。
   */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      if (!this.#runtime) return;
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
      // SDK へ渡す前に全行を保護対象へ入れる (orphan / 不正値 / 適用失敗でも保持する)
      for (const row of rows) this.#retainSecret(row.apiKey);
      const catalog = new Set(this.#runtime.list().map((entry) => entry.provider));
      for (const row of rows) {
        if (row.apiKey.length < PROVIDER_API_KEY_MIN_LENGTH || !catalog.has(row.provider)) {
          this.#degraded.set(row.provider, "apply");
          continue;
        }
        const commit = await applyWithRetry(() =>
          this.#runtime!.applyApiKey(row.provider, row.apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
        );
        if (commitSucceeded(commit)) {
          this.#degraded.delete(row.provider);
          continue;
        }
        this.#degraded.set(row.provider, "apply");
        // 値・cause は出さず、provider id と分類だけを残す
        console.warn(`[u7agent] provider key apply deferred: ${row.provider} (${commit.outcome})`);
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
        return { status: 200, response: { ...this.#compose([], stored), state: "applied" } };
      }
    });
  }

  /** APIキーの登録 (既存は上書き)。DB を先に確定し、SDK の反映失敗は degraded として返す */
  async putKey(provider: string, apiKey: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable();
      const entry = this.#runtime.list().find((candidate) => candidate.provider === provider);
      if (!entry?.canSetApiKey) throw httpError(400, PROVIDER_KEY_TARGET_MESSAGE);
      // マスカーへの登録は SDK / DB より前。ここが失敗しても保護対象だけは残す
      this.#retainSecret(apiKey);
      try {
        this.#db.saveProviderCredential(provider, apiKey);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは provider と操作の分類だけに絞る
        console.warn(`[u7agent] provider key save failed: ${provider}`);
        return this.#notStored();
      }
      const commit = await applyWithRetry(() =>
        this.#runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      return this.#settle(provider, commit, "apply");
    });
  }

  /** この画面で登録したキーの削除。行が無ければ 400 (この画面の管理外は触らない) */
  async deleteKey(provider: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
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
      const commit = await applyWithRetry(() =>
        this.#runtime!.removeApiKey(provider, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      return this.#settle(provider, commit, "remove");
    });
  }

  /**
   * degraded の回復。DB の希望状態を SDK へ再適用するだけで、冪等。
   * 対象はカタログにある provider か、degraded が remove の provider に限る (UI 外の overlay を消さない)。
   */
  async resync(provider: string): Promise<MutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtime) return this.#runtimeUnavailable();
      const inCatalog = this.#runtime.list().some((candidate) => candidate.provider === provider);
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
      const commit = await applyWithRetry(() =>
        row
          ? this.#runtime!.applyApiKey(provider, row.apiKey, { signal: AbortSignal.timeout(this.#timeoutMs) })
          : this.#runtime!.removeApiKey(provider, { signal: AbortSignal.timeout(this.#timeoutMs) }),
      );
      return this.#settle(provider, commit, row ? "apply" : "remove");
    });
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
      // DTO を組めない = クライアントへ反映を確認できない。not_stored とは言わず、未同期として回復導線を残す
      this.#degraded.set(provider, operation);
      // managed (= DB に行がある) を補えるのは apply だけ。apply は直前の書込/読取で行の存在が確定しているが、
      // remove は削除が確定済みなので、ここで保存済みとして返すと [削除] が残り再削除が 400 になる。
      const assumedManaged = operation === "apply" ? provider : undefined;
      return {
        status: 200,
        response: { ...this.#compose([], this.#selectionOrUnset(), assumedManaged), state: "applied_unsynced" },
      };
    }
  }

  /** refresh は例外を出さない契約だが、実装差で lock を壊さないようここでも囲む */
  async #refresh(): Promise<void> {
    try {
      await this.#refreshModelState();
    } catch (error) {
      console.warn(`[u7agent] model state refresh failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  #notStored(error: string = PROVIDER_KEY_NOT_STORED_MESSAGE): MutationOutcome {
    return { status: 503, error };
  }

  #runtimeUnavailable(error: string = PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE): MutationOutcome {
    return this.#notStored(error);
  }

  /** 保存値の読取。行が無ければ未設定 (制限なし・候補の先頭) */
  #readSelection(): StoredModelSelection {
    const row = this.#db.readModelSettings();
    return { allowedModels: row?.allowedModels ?? null, defaultModel: row?.defaultModel ?? null };
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
   * `assumedManaged` は一覧を読めず rows が空のときだけ渡せる「行があると確定している」provider の補正で、
   * 呼び出し側が書込/読取の成功で保証できる apply のときだけ使う (DELETE では渡さない)。
   */
  #compose(
    rows: ProviderCredentialRow[],
    selection: StoredModelSelection,
    assumedManaged?: string,
  ): ModelsSettingsResponse {
    const managed = new Set(rows.map((row) => row.provider));
    if (assumedManaged) managed.add(assumedManaged);
    const providers = new Map<string, ProviderAuthSetting>();
    for (const entry of this.#runtime?.list() ?? []) {
      providers.set(
        entry.provider,
        this.#settingOf(entry.provider, entry.name, this.#runtime?.auth(entry.provider), {
          managed: managed.has(entry.provider),
          canSetApiKey: entry.canSetApiKey,
          supportsOAuth: entry.supportsOAuth,
          orphan: false,
        }),
      );
    }
    for (const row of rows) {
      if (providers.has(row.provider)) continue;
      // カタログに無い行 (orphan) は SDK へ適用できないため、未反映として復旧・削除の導線を出す
      providers.set(
        row.provider,
        this.#settingOf(row.provider, row.provider, undefined, {
          managed: true,
          canSetApiKey: false,
          supportsOAuth: false,
          orphan: true,
        }),
      );
    }
    // 削除に失敗した overlay は DB 行が無く、カタログからも消えていることがある。行が無くても再同期の導線を残す
    for (const provider of this.#degraded.keys()) {
      if (providers.has(provider)) continue;
      providers.set(
        provider,
        this.#settingOf(provider, provider, undefined, {
          managed: managed.has(provider),
          canSetApiKey: false,
          supportsOAuth: false,
          orphan: true,
        }),
      );
    }
    return {
      runtimeAvailable: this.#runtime !== null,
      // 応答は "provider/model" の一覧にする (DB 行は ModelRef の JSON 配列)
      allowedModels: selection.allowedModels?.map(labelOf) ?? null,
      defaultModel: selection.defaultModel,
      ignoredEnvironmentVariables: this.#ignoredEnvironmentVariables,
      providers: [...providers.values()],
    };
  }

  #settingOf(
    provider: string,
    name: string,
    auth: RuntimeAuthStatusLike | undefined,
    flags: { managed: boolean; canSetApiKey: boolean; supportsOAuth: boolean; orphan: boolean },
  ): ProviderAuthSetting {
    const degraded = flags.orphan && !this.#degraded.has(provider) ? "apply" : this.#degraded.get(provider);
    const sanitized: RuntimeAuth = sanitizeRuntimeAuth(auth);
    return {
      provider,
      name,
      auth: sanitized,
      managed: flags.managed,
      canSetApiKey: flags.canSetApiKey,
      supportsOAuth: flags.supportsOAuth,
      orphan: flags.orphan,
      ...(degraded ? { degraded } : {}),
    };
  }
}
