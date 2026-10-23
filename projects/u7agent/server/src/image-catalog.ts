/**
 * 画像モデルカタログの取得と保持。live（OpenRouter の画像モデル一覧 API）を正とし、取得できないときは
 * 前回の成功（アプリ DB のキャッシュ）→ SDK 同梱カタログの順に落とす。一覧 API は API キーを見ないため、
 * 取得はキーの有無・有効性と独立に扱う（正は docs/image-generation.md）。
 */
import type { ImageCatalogModelRow, ImageCatalogRow } from "./app-db";
import {
  IMAGE_ABORTED_MESSAGE,
  IMAGE_PROVIDER_ID,
  imageInputSupportOf,
  imageModelCatalog,
  isUnsaveableOutputOnly,
  type ImageCatalogEntry,
  type ImageInputDeclaration,
} from "./images";

/** いま表示している一覧の出どころ。live 以外は取得に失敗した状態を表す */
export type ImageCatalogSource = "live" | "stored" | "sdk";

export interface ImageCatalogSnapshot {
  entries: ImageCatalogEntry[];
  source: ImageCatalogSource;
  /** live を最後に取得できた時刻 (epoch ms)。SDK へ落ちているときは null */
  fetchedAt: number | null;
}

/** キャッシュの読み書きだけを注入し、カタログは DB を知らない */
export interface ImageCatalogStore {
  readImageCatalog(): ImageCatalogRow | undefined;
  saveImageCatalog(row: ImageCatalogRow): void;
}

export interface ImageCatalogOptions {
  store: ImageCatalogStore;
  /** テストで差し替える。既定は SDK 同梱カタログ（メタモデルを除く） */
  sdkCatalog?: () => readonly ImageCatalogEntry[];
  /** テストで差し替える fetch */
  fetchImpl?: typeof fetch;
  /** テストで固定する時計 */
  now?: () => number;
  timeoutMs?: number;
}

export interface ImageCatalog {
  /** 表示と検証に使う現在の一覧。保存できる形式を宣言した（または宣言が無い）モデルだけを返す */
  snapshot(): ImageCatalogSnapshot;
  /** 形式の宣言。一覧から落ちたモデルも引ける（生成前ガード用）。未知名・宣言なしは undefined */
  outputFormatsOf(model: string): string[] | undefined;
  /** 画像入力の宣言。未知名・宣言なしは undefined（＝不明） */
  imageInputOf(model: string): ImageInputDeclaration | undefined;
  /**
   * 参照画像による編集を provider 呼び出し前に確かめる。可なら undefined、止めるときは理由の固定文言。
   * モデル宣言に加えて endpoint 一覧を編集実行時に 1 回だけ引く（成功だけをメモリに残す）。
   */
  checkImageInput(model: string, signal?: AbortSignal | undefined): Promise<string | undefined>;
  /** キャッシュを読む（live は試さない）。読めなければ SDK 同梱のままにする */
  loadStored(): void;
  /** live を試す。失敗しても一覧を保ち、UI 注記用の固定文言を返す（成功は null） */
  refresh(): Promise<string | null>;
}

/** live 一覧の URL。SDK カタログの baseUrl から組み立てず、取得先をこの 1 箇所に固定する */
export const IMAGE_CATALOG_URL = "https://openrouter.ai/api/v1/images/models";

export const IMAGE_CATALOG_TIMEOUT_MS = 10_000;

export const IMAGE_CATALOG_ERROR_TIMEOUT = "モデル一覧の取得がタイムアウトしました";
export const IMAGE_CATALOG_ERROR_RATE_LIMITED = "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）";
export const IMAGE_CATALOG_ERROR_UNKNOWN = "モデル一覧を取得できませんでした";

/** 参照画像の編集を課金前に止める文言。すべて「課金は起きていない」ことを明示する */
export const IMAGE_INPUT_UNSUPPORTED_MESSAGE =
  "この画像モデルは参照画像による編集に対応していません。編集は行っておらず、クレジットは消費していません。設定 → コンテンツ生成 で画像入力に対応したモデルを選んでください";

export const IMAGE_INPUT_UNKNOWN_MESSAGE =
  "この画像モデルの参照画像入力の可否を宣言から確認できませんでした。編集は行っておらず、クレジットは消費していません。設定 → コンテンツ生成 の [カタログ更新] で最新のモデル一覧を取得してください";

export const IMAGE_INPUT_ENDPOINTS_UNSUPPORTED_MESSAGE =
  "この画像モデルは参照画像を受け付ける経路を 1 つも宣言していません。編集は行っておらず、クレジットは消費していません";

export const IMAGE_INPUT_ENDPOINTS_UNKNOWN_MESSAGE =
  "参照画像を受け付ける経路を provider に確認できませんでした。編集は行っておらず、クレジットは消費していません。時間をおいて試してください";

/** 取得失敗の分類。上流の原文はログにも UI にも出さず、この 3 つへ寄せる */
type FetchOutcome = { entries: ImageCatalogEntry[]; fetchedAt: number } | { error: string };

/**
 * live 応答の `supported_parameters.output_format.values` を読む。宣言が無い / 形が違うときは undefined
 * （＝不明）として扱い、一覧の絞り込みも生成前ガードも動かさない。
 */
function declaredFormatsOf(item: object): string[] | undefined {
  const parameters = (item as { supported_parameters?: unknown }).supported_parameters;
  if (typeof parameters !== "object" || parameters === null) return undefined;
  const outputFormat = (parameters as { output_format?: unknown }).output_format;
  if (typeof outputFormat !== "object" || outputFormat === null) return undefined;
  const values = (outputFormat as { values?: unknown }).values;
  if (!Array.isArray(values)) return undefined;
  const formats = values.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  return formats.length === 0 ? undefined : formats;
}

/** キャッシュの 1 件。宣言が無い行（この項目より前に書かれたキャッシュ）は「不明」として読む */
function entryOf(model: ImageCatalogModelRow): ImageCatalogEntry {
  return {
    provider: IMAGE_PROVIDER_ID,
    id: model.id,
    name: model.name,
    ...(model.outputFormats ? { outputFormats: model.outputFormats } : {}),
    ...(model.input ? { input: model.input } : {}),
  };
}

/** カタログ 1 件をキャッシュ行へ。宣言が無いときは鍵ごと落とす（見分けの付く JSON にする） */
function cacheModelOf(entry: ImageCatalogEntry): ImageCatalogModelRow {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.outputFormats ? { outputFormats: entry.outputFormats } : {}),
    ...(entry.input ? { input: entry.input } : {}),
  };
}

/** live の `architecture.input_modalities`。無い / 形が違うときは undefined（不明） */
function declaredModalitiesOf(item: object): string[] | undefined {
  const architecture = (item as { architecture?: unknown }).architecture;
  if (typeof architecture !== "object" || architecture === null) return undefined;
  const modalities = (architecture as { input_modalities?: unknown }).input_modalities;
  if (!Array.isArray(modalities)) return undefined;
  const values = modalities.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  return values.length === 0 ? undefined : values;
}

/** 参照枚数の宣言。数値は 1 点の range、`{ min, max }` はその範囲として読む */
function referenceRangeOf(value: unknown): { min: number; max: number } | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? { min: value, max: value } : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) return undefined;
  return { min, max };
}

/** live の `supported_parameters.input_references`。宣言が無い / 形が違うときは undefined（不明） */
function declaredReferencesOf(item: object): { min: number; max: number } | undefined {
  const parameters = (item as { supported_parameters?: unknown }).supported_parameters;
  if (typeof parameters !== "object" || parameters === null) return undefined;
  return referenceRangeOf((parameters as { input_references?: unknown }).input_references);
}

/** live の `endpoints`。URL の文字列 / 配列だけを読み、他の形は無視する */
function declaredEndpointsOf(item: object): string[] | undefined {
  const value = (item as { endpoints?: unknown }).endpoints;
  const list = Array.isArray(value) ? value : [value];
  const urls = list.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return urls.length === 0 ? undefined : urls;
}

/** 宣言の内、読めた項目だけを残す。1 つも読めなければ undefined（＝不明） */
function declaredInputOf(item: object): ImageInputDeclaration | undefined {
  const modalities = declaredModalitiesOf(item);
  const references = declaredReferencesOf(item);
  const endpoints = declaredEndpointsOf(item);
  if (!modalities && !references && !endpoints) return undefined;
  return {
    ...(modalities ? { modalities } : {}),
    ...(references ? { references } : {}),
    ...(endpoints ? { endpoints } : {}),
  };
}

/** `data[]` から id / 表示名 / 形式 / 入力の宣言を読む。1 件も読めない応答は契約外として失敗にする */
function entriesOf(body: unknown): ImageCatalogEntry[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const entries: ImageCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const outputFormats = declaredFormatsOf(item);
    const input = declaredInputOf(item);
    entries.push({
      provider: IMAGE_PROVIDER_ID,
      id,
      name: typeof name === "string" ? name : "",
      ...(outputFormats ? { outputFormats } : {}),
      ...(input ? { input } : {}),
    });
  }
  return entries.length === 0 ? undefined : entries;
}

/** endpoint 一覧の URL。宣言を優先し、無ければ慣例パスを編集実行時に引く */
function endpointUrlsOf(entry: ImageCatalogEntry): string[] {
  const declared = entry.input?.endpoints ?? [`${IMAGE_CATALOG_URL}/${entry.id}/endpoints`];
  return declared.map((url) => {
    try {
      return new URL(url, IMAGE_CATALOG_URL).toString();
    } catch {
      return url;
    }
  });
}

/**
 * endpoint 一覧の応答から endpoint の配列を読む。live の実応答は `{ id, endpoints: [...] }` で `data` を持たない。
 * 旧い応答形（`data: [...]`）だけを受けていた頃の経路も残すため、`endpoints` が無いときだけ `data` を見る。
 * どちらも配列でない / 空のときは undefined（＝契約外）として扱う。
 */
function endpointListOf(body: object): unknown[] | undefined {
  const endpoints = (body as { endpoints?: unknown }).endpoints;
  // `endpoints` はモデル一覧では URL 文字列でも現れる値なので、配列のときだけ endpoint 一覧の応答と見なす
  if (Array.isArray(endpoints)) return endpoints.length === 0 ? undefined : endpoints;
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) && data.length > 0 ? data : undefined;
}

/**
 * endpoint 一覧の応答から 1 枚の参照画像を受け付けられるかを読む。`architecture` の欠落は契約外にしないが、
 * `input_references` の宣言が無い / 形が違う endpoint は「不明」として編集を止める（課金前）。
 */
function endpointSupportOf(body: unknown): "supported" | "unsupported" | "unknown" {
  if (typeof body !== "object" || body === null) return "unknown";
  const endpoints = endpointListOf(body);
  if (!endpoints) return "unknown";
  let sawUnknown = false;
  for (const item of endpoints) {
    if (typeof item !== "object" || item === null) {
      sawUnknown = true;
      continue;
    }
    const references = declaredReferencesOf(item);
    if (!references) {
      sawUnknown = true;
      continue;
    }
    if (references.min > 1 || references.max < 1) return "unsupported";
  }
  return sawUnknown ? "unknown" : "supported";
}

/**
 * endpoint 一覧の取得。編集実行時だけ呼び、認証ヘッダを付けず、既存のカタログ取得と同じ期限を掛ける。
 * 失敗・中断中は「不明」として課金前に止める。
 */
async function fetchImageInputSupport(
  urls: readonly string[],
  baseFetch: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<"supported" | "unsupported" | "unknown"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onUserAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onUserAbort, { once: true });
  if (signal?.aborted) onUserAbort();
  try {
    for (const url of urls) {
      const response = await baseFetch(url, { signal: controller.signal });
      if (!response.ok) return "unknown";
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const support = endpointSupportOf(body);
      if (support !== "supported") return support;
    }
    return "supported";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }
}

export function createImageCatalog(options: ImageCatalogOptions): ImageCatalog {
  const store = options.store;
  const sdkCatalog = options.sdkCatalog ?? (() => imageModelCatalog());
  const baseFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? IMAGE_CATALOG_TIMEOUT_MS;

  let entries: ImageCatalogEntry[] = [...sdkCatalog()];
  let source: ImageCatalogSource = "sdk";
  let fetchedAt: number | null = null;
  /** endpoint の確認に成功した組。失敗は残さず、次の実行で引き直す */
  const verifiedEndpoints = new Set<string>();

  /**
   * 取得成功を採用する。メモリを先に更新し、キャッシュ保存の失敗は次の起動で前回の一覧が消えるだけなので
   * ログに留める（いま返している一覧は live のままで正しい）。
   */
  const adopt = (outcome: { entries: ImageCatalogEntry[]; fetchedAt: number }): void => {
    entries = outcome.entries;
    source = "live";
    fetchedAt = outcome.fetchedAt;
    try {
      store.saveImageCatalog({ fetchedAt: outcome.fetchedAt, models: outcome.entries.map(cacheModelOf) });
    } catch {
      console.warn("[u7agent] image catalog cache save failed");
    }
  };

  const fetchLive = async (): Promise<FetchOutcome> => {
    // 期限はこのタイマーだけに掛ける（SDK は通さない）
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await baseFetch(IMAGE_CATALOG_URL, { signal: controller.signal });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const entries = response.ok ? entriesOf(body) : undefined;
      if (entries) return { entries, fetchedAt: now() };
      if (timedOut) return { error: IMAGE_CATALOG_ERROR_TIMEOUT };
      if (response.status === 429 || response.status >= 500) return { error: IMAGE_CATALOG_ERROR_RATE_LIMITED };
      return { error: IMAGE_CATALOG_ERROR_UNKNOWN };
    } catch {
      return timedOut ? { error: IMAGE_CATALOG_ERROR_TIMEOUT } : { error: IMAGE_CATALOG_ERROR_UNKNOWN };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    snapshot: () => ({
      // 形式が不明なモデル（SDK 同梱・古いキャッシュ）は落とさない。宣言はサーバー側の判定にだけ使い、
      // 形式を選べない UI へは載せない（載せても使う先が無く、応答の形だけが広がる）
      entries: entries
        .filter((entry) => !isUnsaveableOutputOnly(entry.outputFormats))
        .map(({ provider, id, name }) => ({ provider, id, name })),
      source,
      fetchedAt,
    }),

    outputFormatsOf: (model) => entries.find((entry) => entry.id === model)?.outputFormats,

    imageInputOf: (model) => entries.find((entry) => entry.id === model)?.input,

    checkImageInput: async (model, signal) => {
      const entry = entries.find((candidate) => candidate.id === model);
      const support = imageInputSupportOf(entry?.input);
      if (support === "unsupported") return IMAGE_INPUT_UNSUPPORTED_MESSAGE;
      if (!entry || support === "unknown") return IMAGE_INPUT_UNKNOWN_MESSAGE;
      const urls = endpointUrlsOf(entry);
      const key = `${model}\u0000${urls.join(" ")}`;
      if (verifiedEndpoints.has(key)) return undefined;
      const endpoints = await fetchImageInputSupport(urls, baseFetch, timeoutMs, signal);
      if (signal?.aborted) throw new Error(IMAGE_ABORTED_MESSAGE);
      if (endpoints === "supported") {
        verifiedEndpoints.add(key);
        return undefined;
      }
      return endpoints === "unsupported"
        ? IMAGE_INPUT_ENDPOINTS_UNSUPPORTED_MESSAGE
        : IMAGE_INPUT_ENDPOINTS_UNKNOWN_MESSAGE;
    },

    loadStored: () => {
      try {
        const stored = store.readImageCatalog();
        if (!stored) return;
        entries = stored.models.map(entryOf);
        source = "stored";
        fetchedAt = stored.fetchedAt;
      } catch (error) {
        console.warn(
          `[u7agent] image catalog cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    refresh: async () => {
      const outcome = await fetchLive();
      if ("error" in outcome) {
        console.warn(`[u7agent] image catalog fetch failed: ${outcome.error}`);
        return outcome.error;
      }
      adopt(outcome);
      return null;
    },
  };
}
