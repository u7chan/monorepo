/**
 * 音声モデルカタログの取得と保持。live（OpenRouter の音声モデル一覧 API）を正とし、取得できないときは
 * 前回の成功（アプリ DB のキャッシュ）→ 同梱の既定 1 件の順に落とす。一覧 API は API キーを見ないため、
 * 取得はキーの有無・有効性と独立に扱う（正は docs/speech-generation.md）。
 */
import type { SpeechCatalogModelRow, SpeechCatalogRow } from "./app-db";
import { SPEECH_PROVIDER_ID } from "./speech";

/** いま表示している一覧の出どころ。live 以外は取得に失敗した状態を表す */
export type SpeechCatalogSource = "live" | "stored" | "default";

export interface SpeechCatalogEntry {
  provider: string;
  id: string;
  name: string;
  /** live が宣言する話者。宣言が無い / 形が違うときは載せない（＝不明。自由記述を許す） */
  voices?: string[] | undefined;
}

export interface SpeechCatalogSnapshot {
  entries: SpeechCatalogEntry[];
  source: SpeechCatalogSource;
  /** live を最後に取得できた時刻 (epoch ms)。同梱の既定へ落ちているときは null */
  fetchedAt: number | null;
}

/** キャッシュの読み書きだけを注入し、カタログは DB を知らない */
export interface SpeechCatalogStore {
  readSpeechCatalog(): SpeechCatalogRow | undefined;
  saveSpeechCatalog(row: SpeechCatalogRow): void;
}

export interface SpeechCatalogOptions {
  store: SpeechCatalogStore;
  /** テストで差し替える。既定は同梱の 1 件 */
  defaultCatalog?: () => readonly SpeechCatalogEntry[];
  /** テストで差し替える fetch */
  fetchImpl?: typeof fetch;
  /** テストで固定する時計 */
  now?: () => number;
  timeoutMs?: number;
}

export interface SpeechCatalog {
  /** 表示と検証に使う現在の一覧 */
  snapshot(): SpeechCatalogSnapshot;
  /** 話者の宣言。一覧から落ちたモデルも引ける（実行前ガード用）。未知名・宣言なしは undefined */
  voicesOf(model: string): readonly string[] | undefined;
  /** キャッシュを読む（live は試さない）。読めなければ同梱の既定のままにする */
  loadStored(): void;
  /** live を試す。失敗しても一覧を保ち、UI 注記用の固定文言を返す（成功は null） */
  refresh(): Promise<string | null>;
}

/** live 一覧の URL。取得先をこの 1 箇所に固定する */
export const SPEECH_CATALOG_URL = "https://openrouter.ai/api/v1/models?output_modalities=speech";

export const SPEECH_CATALOG_TIMEOUT_MS = 10_000;

export const SPEECH_CATALOG_ERROR_TIMEOUT = "モデル一覧の取得がタイムアウトしました";
export const SPEECH_CATALOG_ERROR_RATE_LIMITED = "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）";
export const SPEECH_CATALOG_ERROR_UNKNOWN = "モデル一覧を取得できませんでした";

/** 既定の音声モデル。live もキャッシュも無いときの 1 件で、キー登録で作る行の初期値でもある */
export const DEFAULT_SPEECH_MODEL = "google/gemini-3.8-flash-tts";

/**
 * 同梱カタログの表示名と話者。出所（`supported_voices` をいつ取得したか）と更新責任は
 * docs/speech-generation.md を正とする。live を一度でも取れれば丸ごと置き換わる。
 */
const DEFAULT_SPEECH_MODEL_NAME = "Google: Gemini 3.8 Flash TTS";
const DEFAULT_SPEECH_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];

/** 同梱の既定カタログ。live 取得に一度も成功していないときの表示と、キー登録直後の既定になる */
export function defaultSpeechCatalog(): SpeechCatalogEntry[] {
  return [
    {
      provider: SPEECH_PROVIDER_ID,
      id: DEFAULT_SPEECH_MODEL,
      name: DEFAULT_SPEECH_MODEL_NAME,
      voices: [...DEFAULT_SPEECH_VOICES],
    },
  ];
}

/** 取得失敗の分類。上流の原文はログにも UI にも出さず、この 3 つへ寄せる */
type FetchOutcome = { entries: SpeechCatalogEntry[]; fetchedAt: number } | { error: string };

/**
 * live 応答の `supported_voices` を読む。宣言が無い / 形が違う / 空のときは undefined（＝不明）として
 * 扱い、生成前ガードも UI の自由記述も動かさない。
 */
function declaredVoicesOf(item: object): string[] | undefined {
  const voices = (item as { supported_voices?: unknown }).supported_voices;
  if (!Array.isArray(voices)) return undefined;
  const names = voices.filter((voice): voice is string => typeof voice === "string" && voice.trim() !== "");
  if (names.length === 0) return undefined;
  return [...new Set(names)];
}

/** キャッシュの 1 件。宣言が無い行（この項目より前に書かれたキャッシュ）は「不明」として読む */
function entryOf(model: SpeechCatalogModelRow): SpeechCatalogEntry {
  return model.voices
    ? { provider: SPEECH_PROVIDER_ID, id: model.id, name: model.name, voices: model.voices }
    : { provider: SPEECH_PROVIDER_ID, id: model.id, name: model.name };
}

/** カタログ 1 件をキャッシュ行へ。宣言が無いときは鍵ごと落とす（見分けの付く JSON にする） */
function cacheModelOf(entry: SpeechCatalogEntry): SpeechCatalogModelRow {
  return entry.voices ? { id: entry.id, name: entry.name, voices: entry.voices } : { id: entry.id, name: entry.name };
}

/** `data[]` から id / 表示名 / 話者の宣言を読む。1 件も読めない応答は契約外として失敗にする */
function entriesOf(body: unknown): SpeechCatalogEntry[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const entries: SpeechCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const voices = declaredVoicesOf(item);
    entries.push({
      provider: SPEECH_PROVIDER_ID,
      id,
      name: typeof name === "string" ? name : "",
      ...(voices ? { voices } : {}),
    });
  }
  return entries.length === 0 ? undefined : entries;
}

export function createSpeechCatalog(options: SpeechCatalogOptions): SpeechCatalog {
  const store = options.store;
  const defaultCatalog = options.defaultCatalog ?? (() => defaultSpeechCatalog());
  const baseFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? SPEECH_CATALOG_TIMEOUT_MS;

  let entries: SpeechCatalogEntry[] = [...defaultCatalog()];
  let source: SpeechCatalogSource = "default";
  let fetchedAt: number | null = null;

  /**
   * 取得成功を採用する。メモリを先に更新し、キャッシュ保存の失敗は次の起動で前回の一覧が消えるだけなので
   * ログに留める（いま返している一覧は live のままで正しい）。
   */
  const adopt = (outcome: { entries: SpeechCatalogEntry[]; fetchedAt: number }): void => {
    entries = outcome.entries;
    source = "live";
    fetchedAt = outcome.fetchedAt;
    try {
      store.saveSpeechCatalog({ fetchedAt: outcome.fetchedAt, models: outcome.entries.map(cacheModelOf) });
    } catch {
      console.warn("[u7agent] speech catalog cache save failed");
    }
  };

  const fetchLive = async (): Promise<FetchOutcome> => {
    // 期限はこのタイマーだけに掛ける
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await baseFetch(SPEECH_CATALOG_URL, { signal: controller.signal });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const entries = response.ok ? entriesOf(body) : undefined;
      if (entries) return { entries, fetchedAt: now() };
      if (timedOut) return { error: SPEECH_CATALOG_ERROR_TIMEOUT };
      if (response.status === 429 || response.status >= 500) return { error: SPEECH_CATALOG_ERROR_RATE_LIMITED };
      return { error: SPEECH_CATALOG_ERROR_UNKNOWN };
    } catch {
      return timedOut ? { error: SPEECH_CATALOG_ERROR_TIMEOUT } : { error: SPEECH_CATALOG_ERROR_UNKNOWN };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    snapshot: () => ({
      entries: entries.map(entryOf),
      source,
      fetchedAt,
    }),

    voicesOf: (model) => entries.find((entry) => entry.id === model)?.voices,

    loadStored: () => {
      try {
        const stored = store.readSpeechCatalog();
        if (!stored) return;
        entries = stored.models.map(entryOf);
        source = "stored";
        fetchedAt = stored.fetchedAt;
      } catch (error) {
        console.warn(
          `[u7agent] speech catalog cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    refresh: async () => {
      const outcome = await fetchLive();
      if ("error" in outcome) {
        console.warn(`[u7agent] speech catalog fetch failed: ${outcome.error}`);
        return outcome.error;
      }
      adopt(outcome);
      return null;
    },
  };
}
