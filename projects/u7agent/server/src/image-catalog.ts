/**
 * 画像モデルカタログの取得と保持。live（OpenRouter の画像モデル一覧 API）を正とし、取得できないときは
 * 前回の成功（アプリ DB のキャッシュ）→ SDK 同梱カタログの順に落とす。一覧 API は API キーを見ないため、
 * 取得はキーの有無・有効性と独立に扱う（正は docs/image-generation.md）。
 */
import type { ImageCatalogRow } from "./app-db";
import { IMAGE_PROVIDER_ID, imageModelCatalog, type ImageCatalogEntry } from "./images";

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
  /** 表示と検証に使う現在の一覧。同期で例外を投げない */
  snapshot(): ImageCatalogSnapshot;
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

/** 取得失敗の分類。上流の原文はログにも UI にも出さず、この 3 つへ寄せる */
type FetchOutcome = { entries: ImageCatalogEntry[]; fetchedAt: number } | { error: string };

/** `data[]` から id / 表示名を読む。1 件も読めない応答は契約外として失敗にする */
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
    entries.push({ provider: IMAGE_PROVIDER_ID, id, name: typeof name === "string" ? name : "" });
  }
  return entries.length === 0 ? undefined : entries;
}

export function createImageCatalog(options: ImageCatalogOptions): ImageCatalog {
  const store = options.store;
  const sdkCatalog = options.sdkCatalog ?? (() => imageModelCatalog());
  const baseFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? IMAGE_CATALOG_TIMEOUT_MS;

  let snapshot: ImageCatalogSnapshot = { entries: [...sdkCatalog()], source: "sdk", fetchedAt: null };

  /**
   * 取得成功を採用する。メモリを先に更新し、キャッシュ保存の失敗は次の起動で前回の一覧が消えるだけなので
   * ログに留める（いま返している一覧は live のままで正しい）。
   */
  const adopt = (outcome: { entries: ImageCatalogEntry[]; fetchedAt: number }): void => {
    snapshot = { entries: outcome.entries, source: "live", fetchedAt: outcome.fetchedAt };
    try {
      store.saveImageCatalog({
        fetchedAt: outcome.fetchedAt,
        models: outcome.entries.map(({ id, name }) => ({ id, name })),
      });
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
    snapshot: () => snapshot,

    loadStored: () => {
      try {
        const stored = store.readImageCatalog();
        if (!stored) return;
        snapshot = {
          entries: stored.models.map(({ id, name }) => ({ provider: IMAGE_PROVIDER_ID, id, name })),
          source: "stored",
          fetchedAt: stored.fetchedAt,
        };
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
