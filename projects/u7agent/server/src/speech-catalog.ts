import type { SpeechCatalogModelRow, SpeechCatalogRow } from "./app-db";
import { CATALOG_TIMEOUT_MS, createContentModelCatalog } from "./content-model-catalog";
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
  const catalog = createContentModelCatalog({
    kind: "speech",
    url: SPEECH_CATALOG_URL,
    fallbackEntries: options.defaultCatalog ?? defaultSpeechCatalog,
    fallbackSource: "default",
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now,
    timeoutMs: options.timeoutMs ?? CATALOG_TIMEOUT_MS,
    entriesOf,
    readCache: () => store.readSpeechCatalog(),
    saveCache: (row) => store.saveSpeechCatalog(row),
    entryOf,
    cacheModelOf,
  });

  return {
    snapshot: () => {
      const { entries, source, fetchedAt } = catalog.snapshot();
      return { entries: entries.map(entryOf), source, fetchedAt };
    },

    voicesOf: (model) => catalog.entryFor(model)?.voices,
    loadStored: catalog.loadStored,
    refresh: catalog.refresh,
  };
}
