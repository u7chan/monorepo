/**
 * `dom` の本体。レンダリング後の HTML を返す (SPA の初期表示を映すため、JS 実行後の DOM を読む)。
 * 出力はバイト数で切り詰める。無制限にすると 1 回の呼び出しで会話のコンテキストを食う。
 */
import { MAX_DOM_BYTES } from "./limits";
import { navigate } from "./navigation";
import { truncateToBytes } from "./outputs";
import type { BrowserSession } from "./session";

export interface DomOptions {
  navigationTimeoutMs?: number;
  maxBytes?: number;
}

export interface DomResult {
  html: string;
  truncated: boolean;
}

export async function runDom(session: BrowserSession, url: string, options: DomOptions = {}): Promise<DomResult> {
  await navigate(session.page, url, { timeoutMs: options.navigationTimeoutMs });
  const { text, truncated } = truncateToBytes(await session.page.content(), options.maxBytes ?? MAX_DOM_BYTES);
  return { html: text, truncated };
}
