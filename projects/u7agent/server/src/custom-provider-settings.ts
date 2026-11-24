/**
 * 設定 → モデルのカスタムプロバイダー (定義・SDK 登録・未反映の記録・削除待ちの tombstone)。
 * アプリ DB の `custom_providers` を希望状態の正として先に確定し、SDK の runtime overlay へ写す。
 * 写しに失敗しても DB は戻さず degraded として記録し、再同期 / 次回変更 / 再起動で収束させる。
 * 変更の直列化はキー変更と同じロック、未反映の印は同じ表を ModelSettingsService と共有する。
 * 契約と残存リスクは docs/model-settings.md を正とする。
 */
import type { CustomProviderRow } from "./app-db";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
  evaluateAppSecret,
  requireAppSecretCipher,
  type AppSecretState,
} from "./app-secrets";
import { probeCustomProviderModels } from "./custom-provider-probe";
import {
  CUSTOM_PROVIDER_API_KEY_MESSAGE,
  CUSTOM_PROVIDER_ID_CONFLICT_DEGRADED_MESSAGE,
  CUSTOM_PROVIDER_INVALID_STORED_MESSAGE,
  CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  CUSTOM_PROVIDER_NOT_STORED_MESSAGE,
  CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  CUSTOM_PROVIDER_STORED_ROWS_MESSAGE,
  CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE,
  assertCustomProviderIdAvailable,
  customProviderRowOf,
  customProviderRuntimeConfig,
  customProviderSummarySourceOfRow,
  parseCustomProviderApiKey,
  parseCustomProviderInput,
  parseCustomProviderUpdate,
  storedCustomProviderDefinition,
  type CustomProviderDefinition,
  type CustomProviderInput,
  type CustomProviderSummarySource,
  type CustomProviderUpdateInput,
} from "./custom-providers";
import { httpError, messageFor } from "./http";
import type { CredentialCommit, ModelSettingsDb, ProviderKeyRuntime } from "./model-settings";
import type { AppSecretCipher } from "./secret-crypto";
import type { CustomProviderProbeResponse, ModelMutationResponse, ModelsSettingsResponse } from "./schema";

/**
 * カスタムプロバイダーの変更結果。DB を先に確定し、SDK への反映失敗は 200 `applied_unsynced`（degraded）で返す。
 * 503 は **DB 確定前**（読取 / 書込失敗、入力キーの暗号化失敗、ランタイム未初期化）だけに使う。
 */
export type CustomProviderOutcome = { status: 200; response: ModelMutationResponse } | { status: 503; error: string };

/** カスタムプロバイダーが ModelSettingsService と同じものを使う口。別インスタンスにしない */
export interface CustomProviderSettingsPort {
  db: ModelSettingsDb;
  /** キー変更と同じランタイム。null = 初期化失敗で、変更系は 503 not_stored */
  runtime: ProviderKeyRuntime | null;
  /** キーと同じ AEAD。null (master key 未設定 / 不正) は保存も復号も拒否する */
  appCipher: AppSecretCipher | null;
  /** SDK / DB へ触る前に保護対象へ足す (マスカーの swap は同期) */
  retainSecret: (value: string) => void;
  /** 起動時の読取失敗をログへ出す前の文言境界 (可変マスカー) */
  maskError: (text: string) => string;
  /** SDK 操作の期限。timeout は「未適用」と断定せず unknown に倒す */
  timeoutMs: number;
  /** `/models` probe の期限。一覧取得は短く閉じる */
  probeTimeoutMs: number;
  /** `/models` probe の fetch (テスト用)。省略時は globalThis.fetch */
  probeFetch: typeof fetch | undefined;
  /**
   * provider ごとの未反映の印。キー変更と同じ表を共有し、2 本に分けない
   * (カスタム行の id でもキーの degraded でも、1 provider 1 状態として扱う)。
   */
  degraded: Map<string, "apply" | "remove">;
  /** 1 回目の commit が applied/synced でなければ、同じ操作を 1 回だけ再試行する (キー変更と同じ手順) */
  applyWithRetry: (run: () => Promise<CredentialCommit>) => Promise<CredentialCommit>;
  /** 「SDK へ反映済み」の判定 (キー変更と同じ判定) */
  commitSucceeded: (commit: CredentialCommit) => boolean;
  /** 公開 state の再計算。例外を出さない契約は ModelSettingsService が担保する */
  refresh: () => Promise<void>;
  /** GET と同じ DTO。DB を読めないときは例外で、呼び出し側が fallbackSettings へ落とす */
  settings: () => ModelsSettingsResponse;
  /** 一覧を読めないときの DTO。`known` を渡すとその行だけは応答へ残す */
  fallbackSettings: (known?: CustomProviderRow) => ModelsSettingsResponse;
  /** 変更は確定したが DTO を組めないときの応答。degraded を残して applied_unsynced を返す */
  unsynced: (provider: string, operation: "apply" | "remove", known?: CustomProviderRow) => CustomProviderOutcome;
}

function notStored(error: string): { status: 503; error: string } {
  return { status: 503, error };
}

/** カスタムプロバイダーの手順。呼び出し側 (ModelSettingsService) が、キー変更と同じロックの内側で呼ぶ */
export class CustomProviderSettings {
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

  constructor(private readonly port: CustomProviderSettingsPort) {}

  /** 応答の組み立てに渡す、このプロセスが SDK へ登録した id */
  get registered(): ReadonlySet<string> {
    return this.#customRegistered;
  }

  /** 応答の組み立てに渡す、削除待ちの定義 */
  get tombstones(): ReadonlyMap<string, CustomProviderSummarySource> {
    return this.#tombstones;
  }

  /** 応答の組み立てに渡す、degraded の固定文言 */
  get degradedMessages(): ReadonlyMap<string, string> {
    return this.#degradedMessages;
  }

  /**
   * 起動時のカスタム provider の適用。復号 → retainSecret → 検証 → register → key 適用の順を守る。
   * 復号 / 検証に失敗した行は register せず degraded として残し (平文へフォールバックしない)、
   * キーの適用に失敗しても register 済みの ID は外さない (定義は使え、再同期でキーだけ戻せる)。
   * 戻り値は `provider_credentials` の行を抑えるべき id の集合。
   */
  async applyStored(): Promise<Set<string>> {
    const ids = new Set<string>();
    const runtime = this.port.runtime;
    if (!runtime) return ids;
    let rows: CustomProviderRow[];
    try {
      rows = this.port.db.listCustomProviders();
    } catch (error) {
      // 行が読めないと「どの provider_credentials を抑えるか」も分からない。ログだけで続行する
      console.error(`[u7agent] custom providers unavailable: ${this.port.maskError(messageFor(error))}`);
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
    const runtimeProviders = new Set(runtime.list().map((entry) => entry.provider));
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
      if (this.port.commitSucceeded(commit)) {
        this.#clearCustomDegraded(definition.id);
        continue;
      }
      this.#markCustomDegraded(definition.id);
      console.warn(`[u7agent] custom provider key apply deferred: ${definition.id} (${commit.outcome})`);
    }
    return ids;
  }

  /**
   * カスタムプロバイダーの作成。入力検証 → 暗号化 → DB 確定 → SDK 反映の順で行い、
   * SDK の失敗は DB を戻さず degraded (保存済み・未反映) として 200 で返す。
   */
  async create(input: CustomProviderInput): Promise<CustomProviderOutcome> {
    if (!this.port.runtime) return notStored(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
    const definition = parseCustomProviderInput(input);
    assertCustomProviderIdAvailable(definition.id, this.#takenProviderIds());
    this.#assertNoStoredProviderRows(definition.id);
    // マスカーへの登録は SDK / DB / ログより先。ここが失敗しても保護対象だけは残す
    this.port.retainSecret(definition.apiKey);
    let row: CustomProviderRow;
    try {
      row = customProviderRowOf(
        definition,
        requireAppSecretCipher(this.port.appCipher).encrypt("custom_providers", definition.id, definition.apiKey),
      );
    } catch {
      // master key 未設定 / 不正では平文で保存しない。何も変えずに not_stored を返す
      console.warn(`[u7agent] custom provider key encryption failed: ${definition.id}`);
      return notStored(APP_SECRET_NOT_STORED_MESSAGE);
    }
    try {
      this.port.db.saveCustomProvider(row);
    } catch {
      // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
      console.warn(`[u7agent] custom provider save failed: ${definition.id}`);
      return notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
    }
    const synced = await this.#applyCustomDefinition(definition, { needsKey: true, apiKey: definition.apiKey });
    await this.port.refresh();
    return this.#customOutcome(synced, row);
  }

  /**
   * カスタムプロバイダーの更新。id は変更不可、キーの空欄は既存の暗号文の維持。
   * 定義の置き換えとキーの再適用は別の失敗単位で、どちらも DB 確定後の失敗は 200 `applied_unsynced` にする。
   */
  async update(provider: string, input: CustomProviderUpdateInput): Promise<CustomProviderOutcome> {
    if (!this.port.runtime) return notStored(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
    const read = this.#storedRow(provider);
    if ("error" in read) return notStored(read.error);
    const row = read.row;
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
    if (typedKey !== undefined) this.port.retainSecret(typedKey);
    let stored: CustomProviderRow;
    try {
      const secret =
        typedKey === undefined
          ? { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion }
          : requireAppSecretCipher(this.port.appCipher).encrypt("custom_providers", next.id, typedKey);
      stored = customProviderRowOf({ ...next, apiKey: typedKey ?? "" }, secret);
    } catch {
      console.warn(`[u7agent] custom provider key encryption failed: ${provider}`);
      return notStored(APP_SECRET_NOT_STORED_MESSAGE);
    }
    try {
      this.port.db.saveCustomProvider(stored);
    } catch {
      console.warn(`[u7agent] custom provider save failed: ${provider}`);
      return notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
    }
    // キーの適用は「変わったとき」か「まだ反映できていないとき」だけ。同しキーの再適用で無駄に待たせない
    const needsKey =
      (typedKey !== undefined && typedKey !== storedKey) ||
      !this.#customRegistered.has(provider) ||
      this.port.degraded.get(provider) === "apply";
    const synced = await this.#applyCustomDefinition(next, {
      needsKey,
      row: stored,
      apiKey: typedKey,
    });
    await this.port.refresh();
    return this.#customOutcome(synced, stored);
  }

  /**
   * カスタムプロバイダーの削除。DB を先に消し、SDK は overlay (キー) → 登録の順に外す。
   * 後始末に失敗したら行は戻さず、削除待ちの tombstone をメモリに残して degraded `remove` にする。
   */
  async delete(provider: string): Promise<CustomProviderOutcome> {
    if (!this.port.runtime) return notStored(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
    const read = this.#storedRow(provider);
    if ("error" in read) return notStored(read.error);
    const row = read.row;
    if (!row) throw httpError(400, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
    const tombstone = customProviderSummarySourceOfRow(row);
    try {
      this.port.db.deleteCustomProvider(provider);
    } catch {
      console.warn(`[u7agent] custom provider delete failed: ${provider}`);
      return notStored(CUSTOM_PROVIDER_NOT_STORED_MESSAGE);
    }
    const synced = await this.#removeCustomDefinition(provider);
    if (synced) {
      this.#tombstones.delete(provider);
      this.#clearCustomDegraded(provider);
    } else {
      this.#tombstones.set(provider, tombstone);
      this.#markCustomDegraded(provider, undefined, "remove");
    }
    await this.port.refresh();
    return this.#customOutcome(synced);
  }

  /**
   * カスタムプロバイダーの `/models` を 1 回だけ叩いて、接続の分類と選べるモデル ID を返す。
   * 状態を変えないのでミューテーションロックを取らず、DB も書かない。master key 未設定 / 復号失敗は
   * 保存を変えないので 503 で閉じる。保存済みキーは応答に載せない。
   */
  async probe(input: { provider?: string; baseUrl: string; apiKey?: string }): Promise<CustomProviderProbeResponse> {
    const typed =
      input.apiKey === undefined || input.apiKey === "" ? undefined : parseCustomProviderApiKey(input.apiKey);
    let storedKey: string | undefined;
    if (input.provider !== undefined) {
      const read = this.#storedRow(input.provider);
      if ("error" in read) throw httpError(503, read.error);
      const row = read.row;
      if (!row) throw httpError(400, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
      if (typed === undefined) {
        const stored = this.#decryptCustomKey(row);
        if (stored.apiKey === null) {
          throw httpError(503, stored.state.keyErrorMessage ?? APP_SECRET_DECRYPT_FAILED_MESSAGE);
        }
        storedKey = stored.apiKey;
      }
    }
    const apiKey = typed ?? storedKey;
    if (apiKey === undefined) throw httpError(400, CUSTOM_PROVIDER_API_KEY_MESSAGE);
    if (typed !== undefined) this.port.retainSecret(typed);
    return probeCustomProviderModels(
      { baseUrl: input.baseUrl, apiKey },
      {
        ...(this.port.probeFetch === undefined ? {} : { fetchImpl: this.port.probeFetch }),
        timeoutMs: this.port.probeTimeoutMs,
      },
    );
  }

  /**
   * 再同期のうち、カスタム provider の DB 行 / 削除待ち tombstone を対象にする部分。
   * どちらでもないときは undefined を返し、呼び出し側が通常の `provider_credentials` の手順へ進む
   * (行と tombstone が同じ id に併存する異常状態では行を優先する)。
   */
  async resync(provider: string): Promise<CustomProviderOutcome | undefined> {
    if (!this.port.runtime) return notStored(CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE);
    const read = this.#storedRow(provider);
    if ("error" in read) return notStored(read.error);
    const row = read.row;
    if (row) {
      const synced = await this.#resyncCustomRow(row);
      await this.port.refresh();
      return this.#customSettled(provider, synced, row);
    }
    const tombstone = this.#tombstones.get(provider);
    if (!tombstone) return undefined;
    const synced = await this.#removeCustomDefinition(provider);
    if (synced) {
      this.#tombstones.delete(provider);
      this.#clearCustomDegraded(provider);
    } else {
      this.#markCustomDegraded(provider, undefined, "remove");
    }
    await this.port.refresh();
    return this.#customSettled(provider, synced);
  }

  /** カスタム provider の一覧。読取失敗は例外 (呼び出し側が GET の 503 として扱う) */
  rows(): CustomProviderRow[] {
    return this.port.db.listCustomProviders();
  }

  /**
   * 一覧のフォールバック用。読めないときは空で縮退し、次の GET の 503 で気付けるようにする。
   * `known` を渡すと、その行だけは読取失敗に巻き込まずに応答へ残す。
   */
  rowsOrEmpty(known?: CustomProviderRow): CustomProviderRow[] {
    try {
      return this.port.db.listCustomProviders();
    } catch {
      return known ? [known] : [];
    }
  }

  /**
   * カスタムプロバイダーのキー・メモは専用の API だけで扱う。削除待ち tombstone の id も予約済みとして
   * 拒否し、後始末が終わるまで同じ id の行を作らせない。
   */
  assertNotProvider(provider: string, error: string): void {
    if (this.#tombstones.has(provider)) throw httpError(400, error);
    let row: CustomProviderRow | undefined;
    try {
      row = this.port.db.getCustomProvider(provider);
    } catch {
      console.warn(`[u7agent] custom provider read failed: ${provider}`);
      throw httpError(503, CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE);
    }
    if (row) throw httpError(400, error);
  }

  /**
   * 保存済みの行。読取に失敗したら 503 の固定文言を返し、呼び出し側が応答 (変更系) か例外 (probe) へ写す。
   * どちらも同じ 503 だが、変更系は `{ error }` を返し、probe は投げる。
   */
  #storedRow(provider: string): { row: CustomProviderRow | undefined } | { error: string } {
    try {
      return { row: this.port.db.getCustomProvider(provider) };
    } catch {
      console.warn(`[u7agent] custom provider read failed: ${provider}`);
      return { error: CUSTOM_PROVIDER_NOT_STORED_MESSAGE };
    }
  }

  /**
   * カスタムプロバイダーの変更応答。一覧を組めないときも変更は確定しているため、
   * `applied` / `applied_unsynced` を保って GET と同じ形で返し、次の GET に追随させる。
   * `known` はこの操作で確定した行で、一覧を読めないときも応答から落とさない
   * (空配列を返すとクライアントが一覧を置き換え、編集・削除・再同期の導線が消える)。
   */
  #customOutcome(synced: boolean, known?: CustomProviderRow): CustomProviderOutcome {
    return this.#settledResponse(synced ? "applied" : "applied_unsynced", known);
  }

  /** カスタムの再同期の応答。一覧を組めないときも `state` を保ち、対象の行を落とさない */
  #customSettled(provider: string, synced: boolean, known?: CustomProviderRow): CustomProviderOutcome {
    if (!synced) return this.port.unsynced(provider, this.port.degraded.get(provider) ?? "apply", known);
    return this.#settledResponse("applied", known);
  }

  /** 一覧を組めないときは `known` の行だけで組み、変更が確定した `state` を保つ */
  #settledResponse(
    state: "applied" | "applied_unsynced",
    known?: CustomProviderRow,
  ): { status: 200; response: ModelMutationResponse } {
    try {
      return { status: 200, response: { ...this.port.settings(), state } };
    } catch {
      return { status: 200, response: { ...this.port.fallbackSettings(known), state } };
    }
  }

  /** 登録済み (runtime) / DB 行 / 削除待ち tombstone の id。衝突判定の入力 */
  #takenProviderIds(): string[] {
    const ids = new Set(this.port.runtime?.list().map((entry) => entry.provider) ?? []);
    for (const id of this.#tombstones.keys()) ids.add(id);
    let rows: CustomProviderRow[];
    try {
      rows = this.port.db.listCustomProviders();
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
        this.port.db.getProviderCredential(provider) !== undefined ||
        this.port.db.getProviderMemo(provider) !== undefined;
    } catch {
      console.warn(`[u7agent] provider stored rows read failed: ${provider}`);
      throw httpError(503, CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE);
    }
    if (stored) throw httpError(400, CUSTOM_PROVIDER_STORED_ROWS_MESSAGE);
  }

  /**
   * SDK へ登録する。成功したときだけ「このプロセスが所有する ID」に加え、失敗しても throw しない
   * (呼び出し側が degraded に倒す)。SDK の例外文言は URL や provider 名を含み得るのでログにも残さない。
   */
  #registerCustom(definition: CustomProviderDefinition): boolean {
    try {
      this.port.runtime!.registerProvider(definition.id, customProviderRuntimeConfig(definition));
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
    const runtimeHas = this.port.runtime!.list().some((entry) => entry.provider === definition.id);
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
    if (!this.port.commitSucceeded(commit)) {
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
    if (!this.port.commitSucceeded(removed)) {
      console.warn(`[u7agent] custom provider key remove deferred: ${provider} (${removed.outcome})`);
      return false;
    }
    try {
      this.port.runtime!.unregisterProvider(provider);
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
      return await this.port.applyWithRetry(() =>
        this.port.runtime!.applyApiKey(provider, apiKey, { signal: AbortSignal.timeout(this.port.timeoutMs) }),
      );
    } catch {
      return { outcome: "unknown" };
    }
  }

  async #removeCustomKey(provider: string): Promise<CredentialCommit> {
    try {
      return await this.port.applyWithRetry(() =>
        this.port.runtime!.removeApiKey(provider, { signal: AbortSignal.timeout(this.port.timeoutMs) }),
      );
    } catch {
      return { outcome: "unknown" };
    }
  }

  /** degraded の記録。`message` を渡したときだけ原因の固定文言を差し替え、省略時は既存を保つ */
  #markCustomDegraded(provider: string, message?: string | null, operation: "apply" | "remove" = "apply"): void {
    this.port.degraded.set(provider, operation);
    if (message) this.#degradedMessages.set(provider, message);
  }

  #clearCustomDegraded(provider: string): void {
    this.port.degraded.delete(provider);
    this.#degradedMessages.delete(provider);
  }

  #decryptCustomKey(row: CustomProviderRow): { apiKey: string | null; state: AppSecretState } {
    const { value: apiKey, state } = evaluateAppSecret({
      cipher: this.port.appCipher,
      // probe は SDK runtime を使わず、保存済みキーを上流へ送る
      runtimeAvailable: true,
      scope: "custom_providers",
      owner: row.provider,
      secret: row,
      retain: (value) => this.port.retainSecret(value),
    });
    return { apiKey, state };
  }
}
