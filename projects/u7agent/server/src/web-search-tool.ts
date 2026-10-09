/**
 * BFF ローカルの `web_search` ツール。既定の provider（アプリ DB を正とする）を 1 回だけ呼び、
 * 上位 5 件を現在日時行 + 出典一覧 + 抜粋へ整形する。サンドボックスの allowlist (`PI_AGENT_TOOLS`) の外にあり、
 * 上流の応答本文と失敗理由はモデル・ログ・UI へ出さない (docs/web-search.md)。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SecretMasker } from "./redact";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";
import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  webSearchProvider,
  type WebSearchFailureKind,
  type WebSearchProviderId,
  type WebSearchResultItem,
} from "./web-search-providers";

export const WEB_SEARCH_TOOL_NAME = "web_search";

/** 上流の期限。SDK 側の期限は渡さず、この自前タイマーだけに一本化する */
export const WEB_SEARCH_TIMEOUT_MS = 60_000;

/** 1 件の抜粋の上限。highlights 1 件が数千字になることがある (実測 5,711 字) */
export const WEB_SEARCH_EXCERPT_MAX_LENGTH = 1_500;
/** 結果全体の上限。SDK は customTool の結果を長さで丸めないため、ツール側で切る */
export const WEB_SEARCH_OUTPUT_MAX_LENGTH = 12_000;
const WEB_SEARCH_TRUNCATED_MARKER = "... [truncated]";
/** 接続例外に添える詳細の上限 */
const WEB_SEARCH_DETAIL_MAX_LENGTH = 500;
/** 日時行と公開日に使うタイムゾーン。UI は日本語で利用者は JST (設定化は非ゴール、docs/web-search.md) */
export const WEB_SEARCH_TIME_ZONE = "Asia/Tokyo";

export const WEB_SEARCH_PROVIDER_ERROR_MESSAGE = "検索プロバイダのエラーが発生しました";
export const WEB_SEARCH_RATE_LIMITED_MESSAGE = "検索が混雑しています（レート制限）";
export const WEB_SEARCH_QUOTA_EXCEEDED_MESSAGE = "検索の利用上限に達しました（provider のプラン上限）";
export const WEB_SEARCH_KEY_MISSING_MESSAGE =
  "検索プロバイダーのAPIキーが未設定です。設定 → Web 検索 を開いて登録してください。";
export const WEB_SEARCH_KEY_REJECTED_MESSAGE =
  "検索プロバイダーのAPIキーが拒否されました。設定 → Web 検索 を開いて確認してください。";
export const WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE = "検索プロバイダが想定外の応答を返しました";
export const WEB_SEARCH_NETWORK_ERROR_MESSAGE = "検索プロバイダに接続できませんでした";
export const WEB_SEARCH_SETTINGS_UNAVAILABLE_MESSAGE = "検索の設定を読み取れませんでした";
export const WEB_SEARCH_TIMEOUT_MESSAGE = "web_search がタイムアウトしました";
export const WEB_SEARCH_ABORTED_MESSAGE = "web_search を中断しました";
export const WEB_SEARCH_NO_RESULTS_MESSAGE = "結果が見つかりませんでした";
/** 画面が同じ文言を出すため、設定 API もこれを `disabledMessage` として返す */
export const WEB_SEARCH_DISABLED_MESSAGE =
  "Web 検索は無効化されています。有効にするには 設定 → Web 検索 を開いてください。";

/** provider が返す失敗の種類 → モデルへ返す固定文言。provider の応答本文は使わない */
const WEB_SEARCH_FAILURE_MESSAGES: Record<WebSearchFailureKind, string> = {
  rate_limited: WEB_SEARCH_RATE_LIMITED_MESSAGE,
  quota_exceeded: WEB_SEARCH_QUOTA_EXCEEDED_MESSAGE,
  key_missing: WEB_SEARCH_KEY_MISSING_MESSAGE,
  key_rejected: WEB_SEARCH_KEY_REJECTED_MESSAGE,
  provider_error: WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
  unexpected_response: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE,
};

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web and return the top results with their titles, URLs, published dates and excerpts. " +
  "Use it to find URLs to open or cite; use `curl` in bash to read a URL you already know.";

export const WEB_SEARCH_TOOL_GUIDELINES = [
  "Use web_search when you need candidate URLs or current information; when you already know the URL, read its content with `curl` in bash instead.",
  "Cite only the URLs web_search returned and never invent a URL or a source the results do not contain.",
  "Results start with the current date and time zone; treat it as the source of truth for today and never assume the current year from memory.",
  "When the user does not give a year, do not invent one: search without a year first, then, if the question depends on the current date (this year, latest, new release, next installment) and the results are clearly older than the date at the head of the results, search again with that year.",
];

const webSearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    // minLength だけでは "   " が通る。上流へ送って isError が返る往復を消す
    pattern: "\\S",
    description: "Search query. It is sent to an external search provider; do not include secrets.",
  }),
});
type WebSearchParams = Static<typeof webSearchSchema>;

type WebSearchOutcome = { ok: true; items: WebSearchResultItem[] } | { ok: false; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Intl.DateTimeFormat の生成は重い。呼び出しごとに作らないよう 1 つだけ持つ
const webSearchDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: WEB_SEARCH_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** JST の YYYY-MM-DD。locale を固定し、`en-CA` の出力書式には依存しない (実行環境の LANG / ICU を避ける) */
function formatWebSearchDate(date: Date): string {
  const parts = webSearchDateFormatter.formatToParts(date);
  const part = (type: "year" | "month" | "day"): string => parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** 結果と失敗文言の先頭に置く現在日時行。日付だけで「今年」の判断には足り、表示と cache が安定する */
function currentDateLine(now: Date): string {
  return `現在日時: ${formatWebSearchDate(now)} (${WEB_SEARCH_TIME_ZONE})`;
}

/** 公開日を JST の YYYY-MM-DD へ。値が無い / parse できないときは括弧ごと省く */
function publishedDateLabel(publishedDate: string | undefined): string {
  if (publishedDate === undefined) return "";
  const date = new Date(publishedDate);
  return Number.isNaN(date.getTime()) ? "" : ` (${formatWebSearchDate(date)})`;
}

/** 出典 1 件の見出し。タイトルが無い結果でも位置が分かるようにする */
function sourceLine(item: WebSearchResultItem, index: number): string {
  const title = item.title.trim() === "" ? "(no title)" : item.title.trim();
  const suffix = publishedDateLabel(item.publishedDate);
  return item.url.trim() === ""
    ? `[${index + 1}] ${title}${suffix}`
    : `[${index + 1}] ${title} — ${item.url.trim()}${suffix}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 現在日時行と出典一覧を先頭に、続けて各件の抜粋を並べる。履歴は先頭 900 字しか出さないため順序に意味がある */
export function formatWebSearchResults(items: readonly WebSearchResultItem[], masker: SecretMasker, now: Date): string {
  const header = `${currentDateLine(now)}\n`;
  if (items.length === 0) return `${header}${WEB_SEARCH_NO_RESULTS_MESSAGE}`;
  // 上流の本文は出典や抜粋へ混ざる。1 件の切り詰めが秘密値の途中で切ると完全一致で拾えなくなるため、
  // 切り詰めより先にマスクする
  const masked = items.map((item) => ({
    title: masker.mask(item.title),
    url: masker.mask(item.url),
    excerpt: masker.mask(item.excerpt),
    publishedDate: item.publishedDate,
  }));
  const sources = masked.map((item, index) => sourceLine(item, index));
  const entries = masked.map((item, index) => {
    const excerpt = clip(item.excerpt, WEB_SEARCH_EXCERPT_MAX_LENGTH);
    return excerpt === "" ? sources[index] : `${sources[index]}\n${excerpt}`;
  });
  const text = `${header}出典:\n${sources.join("\n")}\n\n${entries.join("\n\n")}`;
  if (text.length <= WEB_SEARCH_OUTPUT_MAX_LENGTH) return text;
  return `${text.slice(0, WEB_SEARCH_OUTPUT_MAX_LENGTH - WEB_SEARCH_TRUNCATED_MARKER.length)}${WEB_SEARCH_TRUNCATED_MARKER}`;
}

/**
 * 実行中のセッションが読む写し。セッション作成時に凍結すると既存会話へ設定変更が効かないため、
 * execute のたびに読む。設定サービスがロックの内側で差し替える
 */
export interface WebSearchRuntimeConfig {
  readEnabled: () => boolean;
  /** 既定の provider。保存値が無い / 未知なら exa */
  readProvider: () => WebSearchProviderId;
  /** provider の登録キー。keyless では読まれない（未設定は undefined） */
  readApiKey: (provider: WebSearchProviderId) => string | undefined;
}

export interface WebSearchToolOptions {
  /** テストで差し替える fetch。実 API は呼ばない (docs/web-search.md) */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 切り詰めの前に掛ける。`maskSafe` は切り詰めで欠けた断片を拾えない */
  masker: SecretMasker;
  /** 省くと常に有効（既定 ON） */
  readEnabled?: () => boolean;
  /** 省くと既定（Exa） */
  readProvider?: () => WebSearchProviderId;
  /** 省くとキー無し（keyless のみ動く） */
  readApiKey?: (provider: WebSearchProviderId) => string | undefined;
  /** テストで固定する現在日時。execute で 1 回だけ評価する */
  now?: () => Date;
}

export function createWebSearchToolDefinitions(options: WebSearchToolOptions): ToolDefinition[] {
  const baseFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;
  const readEnabled = options.readEnabled ?? ((): boolean => true);
  const readProvider = options.readProvider ?? ((): WebSearchProviderId => DEFAULT_WEB_SEARCH_PROVIDER);
  const readApiKey = options.readApiKey ?? ((): undefined => undefined);
  const readNow = options.now ?? ((): Date => new Date());

  /** 設定の読取は検索の前段。DB が読めないときに上流へ送って失敗を混ぜない */
  function readTarget(): { provider: ReturnType<typeof webSearchProvider>; apiKey: string | undefined } | undefined {
    try {
      const provider = webSearchProvider(readProvider());
      return { provider, apiKey: provider.keyless ? undefined : readApiKey(provider.id) };
    } catch (error) {
      const detail = options.masker.mask(errorMessage(error));
      console.warn(`[u7agent] web search settings unavailable: ${detail.slice(0, WEB_SEARCH_DETAIL_MAX_LENGTH)}`);
      return undefined;
    }
  }

  async function search(query: string, signal: AbortSignal | undefined): Promise<WebSearchOutcome> {
    const target = readTarget();
    if (target === undefined) return { ok: false, message: WEB_SEARCH_SETTINGS_UNAVAILABLE_MESSAGE };
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
      const outcome = await target.provider.search(query, {
        apiKey: target.apiKey,
        fetchImpl: baseFetch,
        signal: controller.signal,
      });
      // provider が応答を返した後でも、期限・中断が先に起きていればそちらを固定文言にする
      if (timedOut) return { ok: false, message: WEB_SEARCH_TIMEOUT_MESSAGE };
      if (aborted()) return { ok: false, message: WEB_SEARCH_ABORTED_MESSAGE };
      if (outcome.ok) return { ok: true, items: outcome.items };
      return { ok: false, message: WEB_SEARCH_FAILURE_MESSAGES[outcome.kind] };
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
      // 判定を execute まで遅らせないと、OFF が既存セッションの次の呼び出しに効かない
      if (!readEnabled()) throw new Error(WEB_SEARCH_DISABLED_MESSAGE);
      const now = readNow();
      const outcome = await search(params.query, signal);
      // 検索に失敗したときこそモデルは記憶で答えるため、日付が最も要る
      if (!outcome.ok) throw new Error(`${currentDateLine(now)}\n${outcome.message}`);
      return {
        content: [{ type: "text", text: formatWebSearchResults(outcome.items, options.masker, now) }],
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
