/**
 * BFF ローカルの `web_search` ツール。keyless な Exa MCP へ tools/call を 1 回送り、上位 5 件を
 * 出典一覧 + 抜粋へ整形する。サンドボックスの allowlist (`PI_AGENT_TOOLS`) の外にあり、
 * 上流の応答本文と失敗理由はモデル・ログ・UI へ出さない (docs/web-search.md)。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SecretMasker } from "./redact";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";

export const WEB_SEARCH_TOOL_NAME = "web_search";

/** tools/call で呼ぶ Exa のツール名。advanced が消えたときの basic へのフォールバックは持たない */
export const WEB_SEARCH_API_TOOL_NAME = "web_search_advanced_exa";

/** keyless な Exa MCP。`tools` クエリで公開するツールを絞る */
export const WEB_SEARCH_ENDPOINT = `https://mcp.exa.ai/mcp?tools=${WEB_SEARCH_API_TOOL_NAME}`;

/** 上流の期限。SDK 側の期限は渡さず、この自前タイマーだけに一本化する */
export const WEB_SEARCH_TIMEOUT_MS = 60_000;

export const WEB_SEARCH_NUM_RESULTS = 5;
/** `results[].text` の上限。highlights には効かないため、整形側で別に切る */
export const WEB_SEARCH_TEXT_MAX_CHARACTERS = 2_000;
/** 1 件の抜粋の上限。highlights 1 件が数千字になることがある (実測 5,711 字) */
export const WEB_SEARCH_EXCERPT_MAX_LENGTH = 1_500;
/** 結果全体の上限。SDK は customTool の結果を長さで丸めないため、ツール側で切る */
export const WEB_SEARCH_OUTPUT_MAX_LENGTH = 12_000;
const WEB_SEARCH_TRUNCATED_MARKER = "... [truncated]";
/** 接続例外に添える詳細の上限 */
const WEB_SEARCH_DETAIL_MAX_LENGTH = 500;

export const WEB_SEARCH_PROVIDER_ERROR_MESSAGE = "検索プロバイダのエラーが発生しました";
export const WEB_SEARCH_RATE_LIMITED_MESSAGE = "検索が混雑しています（無料枠のレート制限）";
export const WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE = "検索プロバイダが想定外の応答を返しました";
export const WEB_SEARCH_NETWORK_ERROR_MESSAGE = "検索プロバイダに接続できませんでした";
export const WEB_SEARCH_TIMEOUT_MESSAGE = "web_search がタイムアウトしました";
export const WEB_SEARCH_ABORTED_MESSAGE = "web_search を中断しました";
export const WEB_SEARCH_NO_RESULTS_MESSAGE = "結果が見つかりませんでした";

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web and return the top results with their titles, URLs and excerpts. " +
  "Use it to find URLs to open or cite; use `curl` in bash to read a URL you already know.";

export const WEB_SEARCH_TOOL_GUIDELINES = [
  "Use web_search when you need candidate URLs or current information; when you already know the URL, read its content with `curl` in bash instead.",
  "Cite only the URLs web_search returned and never invent a URL or a source the results do not contain.",
];

const webSearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    // minLength だけでは "   " が通る。Exa へ送って isError が返る往復を消す
    pattern: "\\S",
    description: "Search query. It is sent to an external search provider (mcp.exa.ai); do not include secrets.",
  }),
});
type WebSearchParams = Static<typeof webSearchSchema>;

/** 検索結果 1 件。v1 では使わない `id` / `image` / `publishedDate` は取り込まない */
export interface WebSearchResultItem {
  title: string;
  url: string;
  /** highlights を連結したもの。無ければ text */
  excerpt: string;
}

type WebSearchOutcome = { ok: true; items: WebSearchResultItem[] } | { ok: false; message: string };

/** JSON.parse は null / 0 も返すため、成否を型で分ける */
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 応答本文を JSON-RPC の応答へ。`Accept` で SSE と JSON の両方を要求する契約なので、
 * `data:` 行 → その連結 → 本文全体の順に解釈する (1 イベントが複数の data 行へ分かれ得る)。
 */
export function parseWebSearchResponseBody(text: string): unknown {
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

/** `results[]` を読む。配列でなければ undefined (想定外の応答) */
function readResultItems(payload: unknown): WebSearchResultItem[] | undefined {
  const results = asRecord(payload)?.results;
  if (!Array.isArray(results)) return undefined;
  return results
    .filter((entry): entry is Record<string, unknown> => asRecord(entry) !== undefined)
    .map((entry) => {
      const highlights = Array.isArray(entry.highlights)
        ? entry.highlights.filter((value): value is string => typeof value === "string")
        : [];
      const joined = highlights.join("\n").trim();
      const excerpt = joined !== "" ? joined : typeof entry.text === "string" ? entry.text.trim() : "";
      return {
        title: typeof entry.title === "string" ? entry.title : "",
        url: typeof entry.url === "string" ? entry.url : "",
        excerpt,
      };
    });
}

/**
 * 200 の応答本文を分類する。JSON-RPC の error → isError → レート制限 → 内容の順に見て、
 * 0 件は正常系として空配列で返す (JSON なので 0 件と解釈不能を区別できる)。
 */
function outcomeFromBody(body: unknown): WebSearchOutcome {
  const response = asRecord(body);
  if (!response || response.error !== undefined) return { ok: false, message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE };
  const result = asRecord(response.result);
  if (!result) return { ok: false, message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE };
  if (result.isError === true) return { ok: false, message: WEB_SEARCH_PROVIDER_ERROR_MESSAGE };
  if (asRecord(result._meta)?.["ai.exa/rateLimited"] === true) {
    return { ok: false, message: WEB_SEARCH_RATE_LIMITED_MESSAGE };
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((part) => asRecord(part)?.text).find((value): value is string => typeof value === "string");
  if (text === undefined) return { ok: false, message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE };
  const parsed = tryParseJson(text);
  if (!parsed.ok) return { ok: false, message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE };
  const items = readResultItems(parsed.value);
  if (!items) return { ok: false, message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE };
  return { ok: true, items };
}

/** 出典 1 件の見出し。タイトルが無い結果でも位置が分かるようにする */
function sourceLine(item: { title: string; url: string }, index: number): string {
  const title = item.title.trim() === "" ? "(no title)" : item.title.trim();
  return item.url.trim() === "" ? `[${index + 1}] ${title}` : `[${index + 1}] ${title} — ${item.url.trim()}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 出典一覧を先頭に、続けて各件の抜粋を並べる。履歴は先頭 900 字しか出さないため順序に意味がある */
export function formatWebSearchResults(items: readonly WebSearchResultItem[], masker: SecretMasker): string {
  if (items.length === 0) return WEB_SEARCH_NO_RESULTS_MESSAGE;
  // 上流の本文は出典や抜粋へ混ざる。1 件の切り詰めが秘密値の途中で切ると完全一致で拾えなくなるため、
  // 切り詰めより先にマスクする
  const masked = items.map((item) => ({
    title: masker.mask(item.title),
    url: masker.mask(item.url),
    excerpt: masker.mask(item.excerpt),
  }));
  const sources = masked.map((item, index) => sourceLine(item, index));
  const entries = masked.map((item, index) => {
    const excerpt = clip(item.excerpt, WEB_SEARCH_EXCERPT_MAX_LENGTH);
    return excerpt === "" ? sources[index] : `${sources[index]}\n${excerpt}`;
  });
  const text = `出典:\n${sources.join("\n")}\n\n${entries.join("\n\n")}`;
  if (text.length <= WEB_SEARCH_OUTPUT_MAX_LENGTH) return text;
  return `${text.slice(0, WEB_SEARCH_OUTPUT_MAX_LENGTH - WEB_SEARCH_TRUNCATED_MARKER.length)}${WEB_SEARCH_TRUNCATED_MARKER}`;
}

export interface WebSearchToolOptions {
  /** テストで差し替える fetch。実 API は呼ばない (docs/web-search.md) */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 切り詰めの前に掛ける。`maskSafe` は切り詰めで欠けた断片を拾えない */
  masker: SecretMasker;
}

export function createWebSearchToolDefinitions(options: WebSearchToolOptions): ToolDefinition[] {
  const baseFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;

  async function search(query: string, signal: AbortSignal | undefined): Promise<WebSearchOutcome> {
    // 期限はここでのみ掛ける。fetch へ渡す signal を共有すると timeout とユーザー中断を区別できない
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onUserAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onUserAbort, { once: true });
    if (signal?.aborted) onUserAbort();
    const aborted = (): boolean => signal?.aborted === true;

    try {
      const response = await baseFetch(WEB_SEARCH_ENDPOINT, {
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
            name: WEB_SEARCH_API_TOOL_NAME,
            arguments: {
              query,
              type: "auto",
              numResults: WEB_SEARCH_NUM_RESULTS,
              enableHighlights: true,
              textMaxCharacters: WEB_SEARCH_TEXT_MAX_CHARACTERS,
            },
          },
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (timedOut) return { ok: false, message: WEB_SEARCH_TIMEOUT_MESSAGE };
      if (aborted()) return { ok: false, message: WEB_SEARCH_ABORTED_MESSAGE };
      // 406 は Accept の実装ミスで、5xx は上流障害。どちらも本文は分類に使わない
      if (!response.ok) return { ok: false, message: WEB_SEARCH_PROVIDER_ERROR_MESSAGE };
      return outcomeFromBody(parseWebSearchResponseBody(text));
    } catch (error) {
      if (timedOut) return { ok: false, message: WEB_SEARCH_TIMEOUT_MESSAGE };
      if (aborted()) return { ok: false, message: WEB_SEARCH_ABORTED_MESSAGE };
      const detail = options.masker.mask(errorMessage(error)).slice(0, WEB_SEARCH_DETAIL_MAX_LENGTH);
      return {
        ok: false,
        message: detail === "" ? WEB_SEARCH_NETWORK_ERROR_MESSAGE : `${WEB_SEARCH_NETWORK_ERROR_MESSAGE}: ${detail}`,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onUserAbort);
    }
  }

  const definition: ToolDefinition<typeof webSearchSchema> = {
    name: WEB_SEARCH_TOOL_NAME,
    label: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    promptSnippet: "Search the web for candidate URLs",
    promptGuidelines: [...WEB_SEARCH_TOOL_GUIDELINES],
    parameters: webSearchSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: WebSearchParams, signal) {
      const outcome = await search(params.query, signal);
      if (!outcome.ok) throw new Error(outcome.message);
      return {
        content: [{ type: "text", text: formatWebSearchResults(outcome.items, options.masker) }],
        details: undefined,
      };
    },
  };
  return [wrapToolDefinitionWithSecretMasker(definition, options.masker)];
}

/** SDK の tools へ渡す登録名。常時公開で、`PI_AGENT_TOOLS` の対象外 */
export function withWebSearchTool(base: readonly string[]): string[] {
  return [...base, WEB_SEARCH_TOOL_NAME];
}
