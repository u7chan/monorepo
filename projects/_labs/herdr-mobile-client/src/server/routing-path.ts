import { getPath } from "hono/utils/url"

export const PAIR_NEW_PATH = "/api/pair/new"

// Vite の proxy を URL.pathname で判定すると、%6e のような復号を取りこぼす。Hono は decodeURI してから
// ルートを照合するため、proxy 側でも同じ関数でパスを求めて判定を一致させる。
export function routingPathname(url: URL | string): string {
  return getPath(new Request(url))
}
