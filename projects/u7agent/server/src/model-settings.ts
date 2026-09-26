/**
 * 設定 → モデル (プロバイダーAPIキー) のサービス。
 * アプリ DB を希望状態の正として先に確定し、SDK の runtime overlay へ写す。写しに失敗しても DB は戻さず、
 * degraded (保存済み・未反映) として記録して resync / 次回変更 / 再起動で収束させる (補償ロールバックは持たない)。
 * 契約と残存リスクは docs/model-settings.md を正とする。
 */
import type { ProviderCredentialRow } from "./app-db";
import { sanitizeRuntimeAuth, type RuntimeAuthStatusLike } from "./agent";
import { httpError, messageFor } from "./http";
import {
  PROVIDER_API_KEY_MIN_LENGTH,
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
  applyApiKey(provider: string, apiKey: string, options: { signal: AbortSignal }): Promise<CredentialCommit>;
  removeApiKey(provider: string, options: { signal: AbortSignal }): Promise<CredentialCommit>;
}

export interface ModelSettingsDb {
  listProviderCredentials(): ProviderCredentialRow[];
  getProviderCredential(provider: string): ProviderCredentialRow | undefined;
  saveProviderCredential(provider: string, apiKey: string): void;
  deleteProviderCredential(provider: string): boolean;
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
  defaultModel: () => string | undefined;
  whitelistConfigured: () => boolean;
  /** SDK 操作の期限。timeout は「未適用」と断定せず unknown に倒す */
  timeoutMs?: number;
}
export const PROVIDER_KEY_SYNC_TIMEOUT_MS = 20_000;

export const PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、APIキーを変更できません";
export const PROVIDER_KEY_NOT_STORED_MESSAGE = "APIキーをアプリデータ（SQLite）へ保存できませんでした";
export const PROVIDER_KEY_TARGET_MESSAGE = "このプロバイダーにはAPIキーを登録できません";
export const PROVIDER_KEY_NOT_MANAGED_MESSAGE = "この画面で登録したAPIキーがありません";
export const PROVIDER_RESYNC_TARGET_MESSAGE = "このプロバイダーは再同期できません";

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

export class ModelSettingsService {
  #db: ModelSettingsDb;
  #runtime: ProviderKeyRuntime | null;
  #retainSecret: (value: string) => void;
  #maskError: (text: string) => string;
  #refreshModelState: () => Promise<void>;
  #defaultModel: () => string | undefined;
  #whitelistConfigured: () => boolean;
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
    this.#defaultModel = options.defaultModel;
    this.#whitelistConfigured = options.whitelistConfigured;
    this.#timeoutMs = options.timeoutMs ?? PROVIDER_KEY_SYNC_TIMEOUT_MS;
  }

  /** GET。純粋読取で、SDK の呼び出しも修復も行わない (DB の失敗は 503 のまま伝える) */
  settings(): ModelsSettingsResponse {
    return this.#compose(this.#db.listProviderCredentials());
  }

  /**
   * 起動時の適用。ロック 1 回・全行の SDK 適用後に refresh 1 回。
   * 読めなかったときは空 DB として黙って続行しない (警告だけ出し、設定 API は 503 のまま)。
   */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      if (!this.#runtime) return;
      let rows: ProviderCredentialRow[];
      try {
        rows = this.#db.listProviderCredentials();
      } catch (error) {
        console.error(`[u7agent] provider credentials unavailable: ${this.#maskError(messageFor(error))}`);
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
      return { status: 200, response: { ...this.#compose([], provider), state: "applied_unsynced" } };
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

  #runtimeUnavailable(): MutationOutcome {
    return this.#notStored(PROVIDER_KEY_RUNTIME_UNAVAILABLE_MESSAGE);
  }

  #compose(rows: ProviderCredentialRow[], fallbackManaged?: string): ModelsSettingsResponse {
    const managed = new Set(rows.map((row) => row.provider));
    if (fallbackManaged) managed.add(fallbackManaged);
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
    const defaultModel = this.#defaultModel();
    return {
      runtimeAvailable: this.#runtime !== null,
      whitelistConfigured: this.#whitelistConfigured(),
      ...(defaultModel ? { defaultModel } : {}),
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
