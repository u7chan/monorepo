/**
 * 標準経路の外部到達ポリシー (docs/browser.md#外部到達の境界)。
 * 通信を止めるのは proxy (proxy.ts) で、ここはその設定値と、エラーの意味を分かりやすくする 2 段目の route を持つ。
 * route は redirect 先では呼ばれないため、単独では境界にならない。
 */
import type { BrowserContext, Route, WebSocketRoute } from "playwright-core";

/** 許可するループバックの表記。別名 (`127.0.0.2`、`[::]` など) は proxy と route の両方で拒否される */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

/** `<-loopback>` で Chromium の暗黙バイパス (localhost + link-local) を外し、許可するループバックだけを登録する */
export const PROXY_BYPASS_LIST = ["<-loopback>", ...LOOPBACK_HOSTS].join(";");

/** 外側の制約に依らず付ける起動引数。`--user-data-dir` は Playwright に管理させるので渡さない */
export const BROWSER_ARGUMENTS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-breakpad",
  "--hide-scrollbars",
] as const;

export const REACH_DENIED_MESSAGE = "u7agent-browser: ループバック以外への通信は拒否します";

/** ブラウザへ渡す起動引数。proxy の設定値と、常に付ける引数を 1 か所で組み立てる */
export function browserArguments(proxyServer: string): string[] {
  return [`--proxy-server=${proxyServer}`, `--proxy-bypass-list=${PROXY_BYPASS_LIST}`, ...BROWSER_ARGUMENTS];
}

export function isLoopbackHost(host: string): boolean {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host.toLowerCase());
}

/**
 * ループバック以外への通信を拒否する。`data:` をはじめネットワーク以外の scheme は外部到達ではないため対象外。
 * 解釈できない URL は拒否側へ倒す。
 */
export function isAllowedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return isLoopbackHost(url.hostname);
}

function handleRequest(route: Route): Promise<void> | void {
  if (isAllowedUrl(route.request().url())) return route.continue();
  return route.abort("blockedbyclient");
}

function handleWebSocket(route: WebSocketRoute): void {
  if (isAllowedUrl(route.url())) {
    route.connectToServer();
    return;
  }
  // connectToServer を呼ばない場合は page 側で開いたままになるため、拒否を伝わる形で閉じる
  route.close({ code: 1008, reason: REACH_DENIED_MESSAGE });
}

/** context 単位で張る (page ごとではなく、popup を含む context 全体へ効かせる) */
export async function installReachPolicy(context: BrowserContext): Promise<void> {
  await context.route("**", handleRequest);
  await context.routeWebSocket("**", handleWebSocket);
}
