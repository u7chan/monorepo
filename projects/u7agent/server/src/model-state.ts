/**
 * モデル状態 (利用可能なモデル・既定モデル・カタログ・認証の表示) の読み取りと導出。
 * SDK の ModelRuntime は引数で受け取り、公開 state は純粋な導出で決める。
 */
import { readFileSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import { VERSION, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatModelRef, modelKey } from "./model-ref";
import { ThinkingLevelSchema } from "./schema";
import type {
  ModelOption,
  ModelRef,
  RuntimeAuth,
  RuntimeModelsResponse,
  RuntimeVersions,
  ThinkingLevel,
} from "./schema";

export const AUTH_REQUIRED_MESSAGE =
  "APIキーが未設定です。設定 → モデル でプロバイダーのAPIキーを登録するか、ANTHROPIC_API_KEY などのプロバイダー用キーを設定してからサーバーを再起動してください。";

const MODEL_UNAVAILABLE_MESSAGE =
  "利用可能なモデルがありません。設定 → モデル で利用可能なモデルとプロバイダーの認証を確認してください。";

export const MODEL_WHITELIST_EMPTY_MESSAGE =
  "利用可能なモデルが 1 つもありません。設定 → モデル で利用可能なモデルとプロバイダーの認証を確認してください。";

/**
 * 保存された既定モデルが無い状態。候補の先頭で代用すると契約で使えないモデルを勝手に選び、
 * 原因の分からない初回失敗を生むため、ここで止めて選択を促す。
 */
export const MODEL_UNSET_MESSAGE =
  "使用するモデルが未設定です。設定 → モデル で既定モデルを選ぶか、モデルを指定してから送信してください。";

/**
 * 設定 → モデル から保存された実効選択。allowedModels の undefined は制限なし、
 * defaultModel の undefined は「既定が未設定」で、候補の先頭では代用しない。
 * 保存の正はアプリ DB で、この値は `ModelSettingsService` が起動時と保存のたびに写す。
 */
export interface ModelSelection {
  allowedModels: ModelRef[] | undefined;
  defaultModel: ModelRef | undefined;
}

/**
 * カタログ更新の試行結果。provider ごとの失敗は件数だけを返し、内訳は応答にもログにも出さない
 * (どの provider が落ちたかは SDK の credential 解決に依存し、利用者の設定を写さないため)。
 */
export interface ModelCatalogRefreshAttempt {
  /** SDK が呼び出し元の signal で中断した (総時間の上限に当たった) */
  aborted: boolean;
  failedProviders: number;
}

/** 未知の段階は設定ミスとして例外にする。 */
function parseThinkingLevel(value: string): ThinkingLevel {
  const parsed = ThinkingLevelSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Effort の値が不正です: ${value}`);
  return parsed.data;
}

/**
 * PI_THINKING を構文解釈する。既定 Effort はこの値 → medium の順で決まる。
 */
export function parseThinkingLevelFromEnv(env: NodeJS.ProcessEnv = process.env): ThinkingLevel {
  return parseThinkingLevel(env.PI_THINKING?.trim() ?? "medium");
}

/**
 * available と許可リストの積。availableModels / modelOptions / selectedModel / resolveModel は
 * 同じ配列から導出するため、絞り込みはここ 1 箇所だけに閉じる。
 */
export function filterModelsByWhitelist(models: PiAiModel<Api>[], whitelist: ModelRef[] | undefined): PiAiModel<Api>[] {
  if (!whitelist) return models;
  return models.filter((model) => whitelist.some((ref) => ref.provider === model.provider && ref.id === model.id));
}

export interface RuntimeAuthStatusLike {
  configured: boolean;
  source?: string;
  label?: string;
}

const AUTH_SOURCES = new Set([
  "environment",
  "stored",
  "runtime",
  "fallback",
  "models_json_key",
  "models_json_command",
]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** AuthStatus.label は任意文字列なので公開せず、環境変数名として検証できたものだけを残す。 */
export function sanitizeRuntimeAuth(status: RuntimeAuthStatusLike | undefined): RuntimeAuth {
  const configured = status?.configured ?? false;
  const source =
    configured && status?.source
      ? AUTH_SOURCES.has(status.source)
        ? (status.source as RuntimeAuth["source"])
        : "unknown"
      : undefined;
  const environmentVariables =
    source === "environment" && typeof status?.label === "string"
      ? [
          ...new Set(
            status.label
              .split(",")
              .map((name) => name.trim())
              .filter((name) => ENVIRONMENT_VARIABLE_NAME.test(name)),
          ),
        ]
      : [];
  return {
    configured,
    ...(source ? { source } : {}),
    environmentVariables,
  };
}

export function runtimeVersionInfo(env: NodeJS.ProcessEnv = process.env): RuntimeVersions {
  let piAi: string | undefined;
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai"));
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string") piAi = packageJson.version;
  } catch {
    // pi-ai has no public version export; dist/package.json may be unavailable in alternate package layouts.
  }
  const commitHash = env.COMMIT_HASH?.trim() || undefined;
  return {
    piCodingAgent: VERSION,
    ...(piAi ? { piAi } : {}),
    ...(commitHash ? { commitHash } : {}),
  };
}

export interface RuntimeCatalogInput {
  catalog: readonly PiAiModel<Api>[];
  available: readonly PiAiModel<Api>[];
  providerIds: readonly string[];
  authStatuses: ReadonlyMap<string, RuntimeAuthStatusLike>;
  versions: RuntimeVersions;
}

/**
 * カタログと available の対応を公開する。許可リストは設定 API (`allowedModels`) だけが持ち、
 * ここに同じ情報を残さない (画面と応答で「許可されているか」の正を 1 つにする)。
 */
export function deriveRuntimeCatalog(input: RuntimeCatalogInput): RuntimeModelsResponse {
  const { catalog, available, providerIds, authStatuses, versions } = input;
  const availableKeys = new Set(available.map(modelKey));
  return {
    catalogCount: catalog.length,
    availableCount: available.length,
    versions,
    providers: [...new Set(providerIds)].map((provider) => ({
      provider,
      auth: sanitizeRuntimeAuth(authStatuses.get(provider)),
      models: catalog
        .filter((model) => model.provider === provider)
        .map((model) => ({
          id: model.id,
          name: model.name || formatModelRef(model),
          available: availableKeys.has(modelKey(model)),
        })),
    })),
  };
}

/** SDK から読んだランタイムのスナップショット (非同期・失敗しうる)。公開 state はここから純粋に導出する。 */
export interface ModelSnapshot {
  /** 許可リスト適用前の利用可能モデル */
  available: PiAiModel<Api>[];
  catalog: PiAiModel<Api>[];
  providerIds: string[];
  authStatuses: Map<string, RuntimeAuthStatusLike>;
  /** getAvailable() 失敗時のみ。値は必ずマスク済み */
  availabilityError?: string;
}

/** health / resolveModel / ピッカーが読む公開 state。常にミューテーションロックの内側で 1 参照だけ差し替える。 */
export interface ModelState {
  availableModels: PiAiModel<Api>[];
  modelOptions: ModelOption[];
  selectedModel?: PiAiModel<Api>;
  defaultModelError?: string;
  /** 候補はあるが保存された既定が無い状態。モデルを選ばずに新規会話を作ると 503 になる */
  defaultModelUnset: boolean;
  availabilityError?: string;
  modelWhitelistExcludesAll: boolean;
  catalog?: RuntimeModelsResponse;
}

/** 可用 0 の安全な state。導出そのものが失敗したときだけ使う (古い可用一覧を成功として残さない) */
export function unavailableModelState(availabilityError?: string): ModelState {
  return {
    availableModels: [],
    modelOptions: [],
    modelWhitelistExcludesAll: false,
    defaultModelUnset: false,
    ...(availabilityError ? { availabilityError } : {}),
  };
}

/**
 * SDK から読むスナップショット。`signal` は SDK の認証ストアのロック待ちへも伝わるため、
 * 期限を共有した呼び出し側が「期限後は公開 state を差し替えない」を決められる (読み取りの中断と失敗を混ぜない)。
 */
export async function readModelSnapshot(
  modelRuntime: ModelRuntime,
  options: { signal?: AbortSignal } = {},
): Promise<ModelSnapshot> {
  const available = [...(await modelRuntime.getAvailable(undefined, signalOptions(options.signal)))];
  const providerIds = modelRuntime.getProviders().map((provider) => provider.id);
  const authStatuses = new Map(
    providerIds.map((provider) => [provider, modelRuntime.getProviderAuthStatus(provider)] as const),
  );
  return { available, catalog: [...modelRuntime.getModels()], providerIds, authStatuses };
}

/** 期限が無いときは SDK へ undefined を渡し、既存の呼び出しと同じ形を保つ */
function signalOptions(signal: AbortSignal | undefined): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}

export interface ModelStateInput {
  snapshot: ModelSnapshot;
  /** 保存されたアプリ既定モデル (undefined = 未設定。候補の先頭では代用しない) */
  requested: ModelRef | undefined;
  whitelist: ModelRef[] | undefined;
  versions: RuntimeVersions;
}

/**
 * スナップショット読取から公開 state までを 1 回分行う。非同期の失敗 (SDK) も導出の失敗 (バグ・契約外データ)
 * も例外にせず、可用 0 の安全な state へ寄せる。
 */
export async function readModelState(input: {
  modelRuntime: ModelRuntime;
  requested: ModelRef | undefined;
  whitelist: ModelRef[] | undefined;
  versions: RuntimeVersions;
  /** health / availabilityError に出るため、SDK の例外文言はここで必ずマスクする */
  maskError: (error: unknown) => string;
  /** 読み取りの期限。abort はここでは例外にせず、可用 0 の安全な state へ寄せる (保持の判断は呼び出し側) */
  signal?: AbortSignal;
}): Promise<ModelState> {
  let snapshot: ModelSnapshot;
  try {
    snapshot = await readModelSnapshot(input.modelRuntime, signalOptions(input.signal) ?? {});
  } catch (error) {
    let catalog: PiAiModel<Api>[] = [];
    try {
      catalog = [...input.modelRuntime.getModels()];
    } catch {
      // カタログも読めないときは空のまま (GET /api/runtime/models は 503 になる)
    }
    snapshot = {
      available: [],
      catalog,
      providerIds: [],
      authStatuses: new Map(),
      availabilityError: input.maskError(error),
    };
  }
  try {
    return deriveModelState({
      snapshot,
      requested: input.requested,
      whitelist: input.whitelist,
      versions: input.versions,
    });
  } catch {
    return unavailableModelState("モデル状態の再計算に失敗しました");
  }
}

/**
 * スナップショットから公開 state を純粋に導出する。可用モデルの絞り込み・既定モデルの選択・
 * カタログの導出を 1 箇所に閉じ、すべての値が同じ available から決まるようにする。
 */
export function deriveModelState({ snapshot, requested, whitelist, versions }: ModelStateInput): ModelState {
  const availableModelList = filterModelsByWhitelist(snapshot.available, whitelist);
  let availabilityError = snapshot.availabilityError;
  let modelWhitelistExcludesAll = false;
  if (whitelist && !availabilityError && availableModelList.length === 0) {
    // 認証が未設定でも許可リストは必ず空になるため、対処先を絞れるよう両方を確認させる文言で返す。
    modelWhitelistExcludesAll = true;
    availabilityError = MODEL_WHITELIST_EMPTY_MESSAGE;
  }

  // getModel() は認証の有無を見ないため、保存された既定モデルも getAvailable() と突き合わせる。
  const selectedModel = requested
    ? availableModelList.find((model) => model.provider === requested.provider && model.id === requested.id)
    : undefined;
  let defaultModelError: string | undefined;
  if (requested && !selectedModel) {
    // 利用不能でも他候補へ黙ってフォールバックせず、ready のままエラーとして伝える。
    defaultModelError = `保存された既定モデルは利用できません: ${formatModelRef(requested)}`;
  }
  // 保存された既定が無い状態は「未設定」として公開する。候補の先頭を勝手に既定にすると、
  // 契約で使えないモデルを選んでしまい、原因の分からない初回失敗になる。
  const defaultModelUnset = !requested && availableModelList.length > 0;

  if (availableModelList.length === 0 && !availabilityError && !defaultModelError) {
    const requestedProvider = requested?.provider;
    const hasConfiguredProvider = requestedProvider
      ? sanitizeRuntimeAuth(snapshot.authStatuses.get(requestedProvider)).configured
      : snapshot.providerIds.some((provider) => sanitizeRuntimeAuth(snapshot.authStatuses.get(provider)).configured);
    availabilityError = hasConfiguredProvider ? MODEL_UNAVAILABLE_MESSAGE : AUTH_REQUIRED_MESSAGE;
  }

  let catalog: RuntimeModelsResponse | undefined;
  if (!snapshot.availabilityError) {
    try {
      catalog = deriveRuntimeCatalog({
        catalog: snapshot.catalog,
        available: snapshot.available,
        providerIds: snapshot.providerIds,
        authStatuses: snapshot.authStatuses,
        versions,
      });
    } catch {
      // カタログの導出は best-effort。失敗しても既存のモデル選択の振る舞いを変えない。
    }
  }

  return {
    availableModels: availableModelList,
    modelOptions: availableModelList.map(modelOptionOf),
    selectedModel,
    defaultModelError,
    defaultModelUnset,
    availabilityError,
    modelWhitelistExcludesAll,
    catalog,
  };
}

/** picker 用の能力情報。SDK のヘルパーをそのまま使い、BFF 側で模倣しない。 */
function modelOptionOf(model: PiAiModel<Api>): ModelOption {
  const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || formatModelRef(model),
    supportsThinking: levels.some((level) => level !== "off"),
    thinkingLevels: levels,
  };
}
