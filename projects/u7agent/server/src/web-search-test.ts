/**
 * 設定 → Web 検索の「テスト検索」。チャットの `web_search` と同じ runner を 1 回だけ呼び、
 * モデルへ返る本文をそのまま返す。会話・履歴・DB へは何も書かない (docs/web-search.md)。
 */
import type { SecretMasker } from "./redact";
import type { WebSearchTestResponse } from "./schema";
import { createWebSearchRunner, type WebSearchRuntimeConfig } from "./web-search-tool";

/** pi ランタイムが無い (起動に失敗した) 環境では、テストの対象になる会話も作れない */
export const WEB_SEARCH_TEST_UNAVAILABLE_MESSAGE = "Web 検索を利用できません";

export type WebSearchTest = (query: string) => Promise<WebSearchTestResponse>;

export interface WebSearchTestOptions {
  /** 実行中のセッションと同じ写し。ロックの内側で差し替わるため、呼び出しのたびに読む */
  runtime: () => WebSearchRuntimeConfig;
  masker: SecretMasker;
  /** テストで差し替える fetch。実 API は呼ばない (docs/web-search.md) */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * 設定画面のテスト検索。所要時間だけを足して runner の結末をそのまま返すため、
 * チャットで起きること (整形・固定文言・マスク・期限) がそのまま画面に出る。
 */
export function createWebSearchTest(options: WebSearchTestOptions): WebSearchTest {
  const runner = createWebSearchRunner({
    masker: options.masker,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    readEnabled: () => options.runtime().readEnabled(),
    readProvider: () => options.runtime().readProvider(),
    readApiKey: (provider) => options.runtime().readApiKey(provider),
  });
  return async (query) => {
    const startedAt = Date.now();
    const result = await runner.run(query);
    return {
      ok: result.ok,
      output: result.text,
      provider: result.provider ?? null,
      resultCount: result.resultCount,
      durationMs: Date.now() - startedAt,
    };
  };
}
