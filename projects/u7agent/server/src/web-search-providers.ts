/**
 * `web_search` の provider adapter。endpoint・request / response の形式・失敗の分類だけを持ち、
 * モデルへ公開する契約（引数 `query`・出典の整形・上限・timeout / abort）は web-search-tool.ts が持つ。
 * provider の失敗は HTTP 200 で返る Exa があるため、種類（kind）までここで確定させ、固定文言への写しは
 * 共通側に任せる（docs/web-search.md）。
 */

export const WEB_SEARCH_PROVIDER_IDS = ["exa", "tavily"] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** 既存の挙動（keyless な Exa MCP）を変えない既定値 */
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = "exa";

/** 保存値・API 入力を provider id へ畳む。未知の値は既定へ寄せる（表示と実行を空にしない） */
export function webSearchProviderIdOf(raw: string | null | undefined): WebSearchProviderId {
  return WEB_SEARCH_PROVIDER_IDS.find((id) => id === raw) ?? DEFAULT_WEB_SEARCH_PROVIDER;
}

/** 検索結果 1 件。provider ごとの差はここへ正規化し、モデルへ出す形は変えない */
export interface WebSearchResultItem {
  title: string;
  url: string;
  /** 抜粋。Exa は highlights（無ければ text）、Tavily は content */
  excerpt: string;
  /** 公開日。provider が string で返したときだけ入り、生のままは出さず整形側で JST の日付にする */
  publishedDate?: string;
}

/**
 * 失敗の種類。`key_missing` は provider 側で「キーが要る」ことを知っているときだけ返す。
 * 自動 fallback はしないため、この種類が他の provider への切り替えに使われることはない。
 */
export type WebSearchFailureKind =
  | "rate_limited"
  | "quota_exceeded"
  | "key_missing"
  | "key_rejected"
  | "provider_error"
  | "unexpected_response";

export type WebSearchProviderOutcome =
  | { ok: true; items: WebSearchResultItem[] }
  | { ok: false; kind: WebSearchFailureKind };

export interface WebSearchProviderContext {
  /** keyless の provider では undefined */
  apiKey: string | undefined;
  /** テストで差し替える fetch。実 API は呼ばない（docs/web-search.md） */
  fetchImpl: typeof fetch;
  /** 共通側が掛ける期限とユーザー中断を兼ねた signal。fetch へそのまま渡す */
  signal: AbortSignal;
}

export interface WebSearchProvider {
  id: WebSearchProviderId;
  /** GUI に出す表示名 */
  name: string;
  /** 検索クエリの送信先。外部送信先を GUI で隠さないため見出し行に出す */
  host: string;
  /** APIキーの登録が要らない provider（共有の keyless エンドポイント） */
  keyless: boolean;
  search(query: string, context: WebSearchProviderContext): Promise<WebSearchProviderOutcome>;
}

/** 上流へ要求する件数。Exa の numResults と Tavily の max_results で共通 */
export const WEB_SEARCH_NUM_RESULTS = 5;

type ParsedJson = { ok: true; value: unknown } | { ok: false };

function tryParseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 結果 1 件を共通形式へ。欠けたフィールドは空文字にして、整形側の「(no title)」へ委ねる */
function readResultItems(
  entries: unknown,
  excerptOf: (entry: Record<string, unknown>) => string,
  publishedDateOf: (entry: Record<string, unknown>) => string | undefined,
): WebSearchResultItem[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  return entries
    .filter((entry): entry is Record<string, unknown> => asRecord(entry) !== undefined)
    .map((entry) => {
      const publishedDate = publishedDateOf(entry);
      return {
        title: typeof entry.title === "string" ? entry.title : "",
        url: typeof entry.url === "string" ? entry.url : "",
        excerpt: excerptOf(entry),
        ...(publishedDate === undefined ? {} : { publishedDate }),
      };
    });
}

/* --- Exa (keyless な MCP へ JSON-RPC の tools/call を 1 回送る) --- */

/** tools/call で呼ぶ Exa のツール名。advanced が消えたときの basic へのフォールバックは持たない */
export const EXA_API_TOOL_NAME = "web_search_advanced_exa";

/** keyless な Exa MCP。`tools` クエリで公開するツールを絞る */
export const EXA_ENDPOINT = `https://mcp.exa.ai/mcp?tools=${EXA_API_TOOL_NAME}`;

/** `results[].text` の上限。highlights には効かないため、整形側で別に切る */
export const EXA_TEXT_MAX_CHARACTERS = 2_000;

/**
 * 応答本文を JSON-RPC の応答へ。`Accept` で SSE と JSON の両方を要求する契約なので、
 * `data:` 行 → その連結 → 本文全体の順に解釈する (1 イベントが複数の data 行へ分かれ得る)。
 */
export function parseExaResponseBody(text: string): unknown {
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload !== "");
  for (const candidate of [...payloads, payloads.join("\n"), text]) {
    if (candidate.trim() === "") continue;
    const parsed = tryParseJson(candidate);
    if (parsed.ok) return parsed.value;
  }
  return undefined;
}

function exaExcerptOf(entry: Record<string, unknown>): string {
  const highlights = Array.isArray(entry.highlights)
    ? entry.highlights.filter((value): value is string => typeof value === "string")
    : [];
  const joined = highlights.join("\n").trim();
  return joined !== "" ? joined : typeof entry.text === "string" ? entry.text.trim() : "";
}

/** string のときだけ採用する。無い / 非文字列は整形側で括弧ごと省かれる */
function exaPublishedDateOf(entry: Record<string, unknown>): string | undefined {
  return typeof entry.publishedDate === "string" ? entry.publishedDate : undefined;
}

/**
 * 200 の応答本文を分類する。JSON-RPC の error → isError → レート制限 → 内容の順に見て、
 * 0 件は正常系として空配列で返す (JSON なので 0 件と解釈不能を区別できる)。
 */
function exaOutcomeFromBody(body: unknown): WebSearchProviderOutcome {
  const response = asRecord(body);
  if (!response || response.error !== undefined) return { ok: false, kind: "unexpected_response" };
  const result = asRecord(response.result);
  if (!result) return { ok: false, kind: "unexpected_response" };
  if (result.isError === true) return { ok: false, kind: "provider_error" };
  if (asRecord(result._meta)?.["ai.exa/rateLimited"] === true) return { ok: false, kind: "rate_limited" };
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((part) => asRecord(part)?.text).find((value): value is string => typeof value === "string");
  if (text === undefined) return { ok: false, kind: "unexpected_response" };
  const parsed = tryParseJson(text);
  if (!parsed.ok) return { ok: false, kind: "unexpected_response" };
  const items = readResultItems(asRecord(parsed.value)?.results, exaExcerptOf, exaPublishedDateOf);
  if (!items) return { ok: false, kind: "unexpected_response" };
  return { ok: true, items };
}

const exaProvider: WebSearchProvider = {
  id: "exa",
  name: "Exa",
  host: "mcp.exa.ai",
  keyless: true,
  async search(query, context) {
    const response = await context.fetchImpl(EXA_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 片方だけだと Exa は HTTP 406 で拒否する (実測)
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: EXA_API_TOOL_NAME,
          arguments: {
            query,
            type: "auto",
            numResults: WEB_SEARCH_NUM_RESULTS,
            enableHighlights: true,
            textMaxCharacters: EXA_TEXT_MAX_CHARACTERS,
          },
        },
      }),
      signal: context.signal,
    });
    const text = await response.text();
    // 406 は Accept の実装ミスで、5xx は上流障害。どちらも本文は分類に使わない
    if (!response.ok) return { ok: false, kind: "provider_error" };
    return exaOutcomeFromBody(parseExaResponseBody(text));
  },
};

/* --- Tavily (APIキー必須の検索 API) --- */

export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/** Tavily の HTTP ステータス → 失敗の種類。プラン上限 (432 / 433) は混雑と別の文言にする */
export function tavilyFailureKind(status: number): WebSearchFailureKind {
  if (status === 429) return "rate_limited";
  if (status === 432 || status === 433) return "quota_exceeded";
  if (status === 401 || status === 403) return "key_rejected";
  return "provider_error";
}

function tavilyExcerptOf(entry: Record<string, unknown>): string {
  return typeof entry.content === "string" ? entry.content.trim() : "";
}

/** string のときだけ採用する。無い / 非文字列は整形側で括弧ごと省かれる */
function tavilyPublishedDateOf(entry: Record<string, unknown>): string | undefined {
  return typeof entry.published_date === "string" ? entry.published_date : undefined;
}

function tavilyOutcomeFromBody(body: unknown): WebSearchProviderOutcome {
  const items = readResultItems(asRecord(body)?.results, tavilyExcerptOf, tavilyPublishedDateOf);
  if (!items) return { ok: false, kind: "unexpected_response" };
  return { ok: true, items };
}

const tavilyProvider: WebSearchProvider = {
  id: "tavily",
  name: "Tavily",
  host: "api.tavily.com",
  keyless: false,
  async search(query, context) {
    // キー未設定は設定ミスとして分類し、空の Authorization で上流へ送らない
    if (context.apiKey === undefined) return { ok: false, kind: "key_missing" };
    const response = await context.fetchImpl(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${context.apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: WEB_SEARCH_NUM_RESULTS,
      }),
      signal: context.signal,
    });
    const text = await response.text();
    // 失敗の本文にはキーの状態やプランの詳細が入る。種類だけを返し、本文はモデル・ログ・UI へ出さない
    if (!response.ok) return { ok: false, kind: tavilyFailureKind(response.status) };
    const parsed = tryParseJson(text);
    if (!parsed.ok) return { ok: false, kind: "unexpected_response" };
    return tavilyOutcomeFromBody(parsed.value);
  },
};

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [exaProvider, tavilyProvider];

/** 表示・実行に使う provider。未知の id は既定へ畳む */
export function webSearchProvider(id: WebSearchProviderId): WebSearchProvider {
  return WEB_SEARCH_PROVIDERS.find((provider) => provider.id === id) ?? WEB_SEARCH_PROVIDERS[0];
}

/** API / GUI へ出す provider の一覧。キーの値は含めない */
export interface WebSearchProviderInfo {
  id: WebSearchProviderId;
  name: string;
  host: string;
  keyless: boolean;
}

export function webSearchProviderCatalog(): WebSearchProviderInfo[] {
  return WEB_SEARCH_PROVIDERS.map(({ id, name, host, keyless }) => ({ id, name, host, keyless }));
}
