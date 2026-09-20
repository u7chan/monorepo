/**
 * `/api/files/html/<path>` の path 部分を組み立てる。サーバー (Hono の `:path{.+}`) は 1 回だけ percent decoding するため、
 * セグメント単位で encode しないと `#` / `?` / `%` が URL の区切りとして解釈される。`/` は区切りのまま残す。
 */
export function encodeFilePathParam(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
