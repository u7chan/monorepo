/**
 * `web_search` の結果本文から provider の表示名を読む。本文に書かれた値だけが正で、provider の
 * 一覧 API は引かない（会話ごとに provider が違い得る。docs/web-search.md#チャットのチップ）。
 */
import type { ToolCard } from "./chatTypes";
import { headValue } from "./toolOutput";
import { WEB_SEARCH_TOOL_NAME } from "./webSearchSettings";

const PROVIDER_LINE = "検索プロバイダー:";

/** 失敗カードの本文にも provider 行が入るため、phase では絞らない */
export function webSearchProviderOf(card: Pick<ToolCard, "name" | "output">): string | undefined {
  if (card.name !== WEB_SEARCH_TOOL_NAME) return undefined;
  return headValue(card.output, PROVIDER_LINE);
}
