/**
 * 設定 → モデルの「カスタムプロバイダー」の型・入力検証・メモリ上の Store。
 * オンメモリで、DB / models.json / auth.json へは書かない (再起動で定義とキーは消える)。
 * 1 provider = 1 model、API は openai-completions 固定。契約と残存リスクは docs/model-settings.md を正とする。
 */
import { httpError } from "./http";
import { PROVIDER_API_KEY_MAX_LENGTH, PROVIDER_API_KEY_MIN_LENGTH } from "./schema";

/** 作成後に変更できない provider id。先頭は英小文字、末尾は英数字、大文字・`/`・空白は不可 */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const CUSTOM_PROVIDER_ID_MAX_LENGTH = 64;
export const CUSTOM_PROVIDER_NAME_MAX_LENGTH = 64;
export const CUSTOM_PROVIDER_BASE_URL_MAX_LENGTH = 2_048;
export const CUSTOM_PROVIDER_MODEL_ID_MAX_LENGTH = 200;
/** maxTokens の既定。contextWindow は実モデル依存なので既定を持たず、入力必須にする */
export const CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS = 16_384;

export const CUSTOM_PROVIDER_ID_MESSAGE =
  "provider id は英小文字で始まり、英小文字・数字・ハイフンのみ 1〜64 文字で指定してください";
export const CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE = "この provider id は既存のプロバイダーと衝突します";
export const CUSTOM_PROVIDER_NAME_MESSAGE = `名前は ${CUSTOM_PROVIDER_NAME_MAX_LENGTH} 文字以内で指定してください`;
export const CUSTOM_PROVIDER_BASE_URL_MESSAGE =
  "baseUrl は http / https の URL を指定してください（userinfo・query・fragment は不可）";
export const CUSTOM_PROVIDER_MODEL_ID_MESSAGE = `モデル ID は空白なしで ${CUSTOM_PROVIDER_MODEL_ID_MAX_LENGTH} 文字以内で指定してください`;
export const CUSTOM_PROVIDER_CONTEXT_WINDOW_MESSAGE =
  "contextWindow は正の整数で指定してください（実モデルの値より大きくしないでください）";
export const CUSTOM_PROVIDER_MAX_TOKENS_MESSAGE = "maxTokens は正の整数で指定してください";
export const CUSTOM_PROVIDER_API_KEY_MESSAGE = `APIキーは ${PROVIDER_API_KEY_MIN_LENGTH}〜${PROVIDER_API_KEY_MAX_LENGTH} 文字で指定してください`;
export const CUSTOM_PROVIDER_NOT_FOUND_MESSAGE = "このカスタムプロバイダーは登録されていません";
export const CUSTOM_PROVIDER_STORED_ROWS_MESSAGE =
  "この provider id には保存済みのキーまたはメモの行があります。設定 → モデルでその provider の行を削除してから登録してください";
export const CUSTOM_PROVIDER_STORED_ROWS_UNAVAILABLE_MESSAGE =
  "保存済みのキー行を確認できないため、カスタムプロバイダーを登録できません";
export const CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、カスタムプロバイダーを変更できません";
export const CUSTOM_PROVIDER_REGISTER_FAILED_MESSAGE = "この内容ではカスタムプロバイダーを登録できません";
export const CUSTOM_PROVIDER_APPLY_FAILED_MESSAGE =
  "カスタムプロバイダーのAPIキーを実行中のランタイムへ反映できなかったため、登録を取り消しました";
export const CUSTOM_PROVIDER_REMOVE_FAILED_MESSAGE =
  "カスタムプロバイダーのAPIキーを削除できなかったため、変更していません";
export const CUSTOM_PROVIDER_KEY_TARGET_MESSAGE =
  "カスタムプロバイダーのAPIキーはカスタムプロバイダーの画面で変更してください";
export const CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE = "カスタムプロバイダーにはメモを保存できません";
export const CUSTOM_PROVIDER_RESYNC_TARGET_MESSAGE = "カスタムプロバイダーは再同期できません";

export interface CustomProviderModelInput {
  id: string;
  contextWindow: number;
  maxTokens?: number;
}

export interface CustomProviderInput {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: CustomProviderModelInput;
}

export interface CustomProviderUpdateInput {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  model: CustomProviderModelInput;
}

export interface CustomProviderModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
}

/** メモリ上の定義。apiKey は応答 (CustomProviderSummary) へ出さない */
export interface CustomProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: CustomProviderModel;
}

/** GET / 変更系の応答に載せる形。キーは返さず、有無だけを hasKey で表す */
export interface CustomProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  api: "openai-completions";
  model: CustomProviderModel;
  hasKey: boolean;
}

/** SDK の型を持ち込まない BFF 側の登録内容。bootstrap が SDK の ProviderConfigInput へ写す */
export interface CustomProviderRuntimeModel {
  id: string;
  name: string;
  input: ["text"];
  reasoning: false;
  cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
  contextWindow: number;
  maxTokens: number;
}

export interface CustomProviderRuntimeConfig {
  name: string;
  baseUrl: string;
  api: "openai-completions";
  models: CustomProviderRuntimeModel[];
}

export const CUSTOM_PROVIDER_API = "openai-completions" as const;

function trimmed(value: string): string {
  return value.trim();
}

/** id の形式だけを見る。衝突判定は呼び出し側が runtime の provider 一覧で行う */
function parseProviderId(value: string): string {
  const id = trimmed(value);
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id) || id.length > CUSTOM_PROVIDER_ID_MAX_LENGTH) {
    throw httpError(400, CUSTOM_PROVIDER_ID_MESSAGE);
  }
  return id;
}

function parseName(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const name = trimmed(value);
  if (name === "") return fallback;
  if (name.length > CUSTOM_PROVIDER_NAME_MAX_LENGTH) throw httpError(400, CUSTOM_PROVIDER_NAME_MESSAGE);
  return name;
}

/**
 * baseUrl の正規化。SDK はそのまま連結して使うため、資格情報 (userinfo)・query・fragment を落とさず
 * 拒否し、末尾の `/` だけを落とす。
 */
export function normalizeCustomProviderBaseUrl(value: string): string {
  const raw = trimmed(value);
  if (raw === "" || raw.length > CUSTOM_PROVIDER_BASE_URL_MAX_LENGTH) {
    throw httpError(400, CUSTOM_PROVIDER_BASE_URL_MESSAGE);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(400, CUSTOM_PROVIDER_BASE_URL_MESSAGE);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw httpError(400, CUSTOM_PROVIDER_BASE_URL_MESSAGE);
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw httpError(400, CUSTOM_PROVIDER_BASE_URL_MESSAGE);
  }
  if (parsed.hostname === "") throw httpError(400, CUSTOM_PROVIDER_BASE_URL_MESSAGE);
  let normalized = raw;
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function parseModelId(value: string): string {
  const id = trimmed(value);
  if (id === "" || id.length > CUSTOM_PROVIDER_MODEL_ID_MAX_LENGTH || /\s/u.test(id)) {
    throw httpError(400, CUSTOM_PROVIDER_MODEL_ID_MESSAGE);
  }
  return id;
}

function parsePositiveInteger(value: number, error: string): number {
  if (!Number.isInteger(value) || value <= 0) throw httpError(400, error);
  return value;
}

function parseModel(input: CustomProviderModelInput): CustomProviderModel {
  return {
    id: parseModelId(input.id),
    contextWindow: parsePositiveInteger(input.contextWindow, CUSTOM_PROVIDER_CONTEXT_WINDOW_MESSAGE),
    maxTokens:
      input.maxTokens === undefined
        ? CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS
        : parsePositiveInteger(input.maxTokens, CUSTOM_PROVIDER_MAX_TOKENS_MESSAGE),
  };
}

export function parseCustomProviderApiKey(value: string): string {
  if (value.length < PROVIDER_API_KEY_MIN_LENGTH || value.length > PROVIDER_API_KEY_MAX_LENGTH) {
    throw httpError(400, CUSTOM_PROVIDER_API_KEY_MESSAGE);
  }
  return value;
}

/** POST の本文を定義へ。id はここで形式だけを検証し、衝突は呼び出し側が見る */
export function parseCustomProviderInput(input: CustomProviderInput): CustomProviderDefinition {
  const id = parseProviderId(input.id);
  return {
    id,
    name: parseName(input.name, id),
    baseUrl: normalizeCustomProviderBaseUrl(input.baseUrl),
    apiKey: parseCustomProviderApiKey(input.apiKey),
    model: parseModel(input.model),
  };
}

/**
 * PUT の本文を定義へ。id は path のものを引き継ぎ、キーの空欄は既存の維持として現在値を残す
 * (キーは応答に載らないため、毎回の再入力は要求しない)。
 */
export function parseCustomProviderUpdate(
  input: CustomProviderUpdateInput,
  current: CustomProviderDefinition,
): CustomProviderDefinition {
  return {
    id: current.id,
    name: parseName(input.name, current.id),
    baseUrl: normalizeCustomProviderBaseUrl(input.baseUrl),
    apiKey:
      input.apiKey === undefined || input.apiKey === "" ? current.apiKey : parseCustomProviderApiKey(input.apiKey),
    model: parseModel(input.model),
  };
}

/**
 * id の衝突判定。built-in / models.json / 登録済みの provider と同じ id は作れない。
 * `self` を渡すと更新時に自分自身を除く (id は変更不可なので、更新で衝突することはない)。
 */
export function assertCustomProviderIdAvailable(id: string, taken: readonly string[], self?: string): void {
  if (id === self) return;
  if (taken.includes(id)) throw httpError(400, CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE);
}

/** SDK へ渡す登録内容。キーは含めず、runtime overlay に置く */
export function customProviderRuntimeConfig(definition: CustomProviderDefinition): CustomProviderRuntimeConfig {
  return {
    name: definition.name,
    baseUrl: definition.baseUrl,
    api: CUSTOM_PROVIDER_API,
    models: [
      {
        id: definition.model.id,
        name: definition.model.id,
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: definition.model.contextWindow,
        maxTokens: definition.model.maxTokens,
      },
    ],
  };
}

export function customProviderSummary(definition: CustomProviderDefinition): CustomProviderSummary {
  return {
    id: definition.id,
    name: definition.name,
    baseUrl: definition.baseUrl,
    api: CUSTOM_PROVIDER_API,
    model: { ...definition.model },
    hasKey: definition.apiKey.length > 0,
  };
}

/**
 * このプロセスのメモリだけが持つ定義の集合。複数登録でき、並びは追加順を保つ。
 * 永続化しないため、再起動で空から始まる (起動時に読む処理は持たない)。
 */
export class CustomProviderStore {
  #entries = new Map<string, CustomProviderDefinition>();

  list(): CustomProviderDefinition[] {
    return [...this.#entries.values()];
  }

  ids(): string[] {
    return [...this.#entries.keys()];
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get(id: string): CustomProviderDefinition | undefined {
    return this.#entries.get(id);
  }

  set(definition: CustomProviderDefinition): void {
    this.#entries.set(definition.id, { ...definition, model: { ...definition.model } });
  }

  delete(id: string): boolean {
    return this.#entries.delete(id);
  }

  summaries(): CustomProviderSummary[] {
    return this.list().map(customProviderSummary);
  }
}
