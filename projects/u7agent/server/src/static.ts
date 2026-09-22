import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_CLIENT_DIST_DIR = resolve(ROOT_DIR, "client", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

// エージェントのアイコンは data URL を <img> で描くため、img-src だけ data: を許す (script-src は 'self' のまま)
const STATIC_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'";

/** SPA フォールバックの対象外にする prefix。`/api` と `/assets` そのものも含める (`/apix` とは区別する) */
const FALLBACK_EXCLUDED_PREFIXES = ["/api", "/assets"];

export function serveClientAssets(clientDistDir: string) {
  return async (c: Context) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      // 不正な percent encoding は静的な解決にもフォールバックにも回さない (例外を index.html の 200 にしない)
      return c.json({ error: "Not found" }, 404);
    }
    const response = await serveClientAsset(pathname, c.req.method, c.req.header("accept"), clientDistDir);
    return response ?? c.json({ error: "Not found" }, 404);
  };
}

function clientBuildMissingResponse(): Response {
  return new Response("Client build missing. Run: pnpm build", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": STATIC_CSP,
    },
  });
}

/**
 * 静的ファイル → SPA フォールバック → null (404) の順に解決する。
 * 未知の画面 URL も 200 と index.html で返すため、HTML が返ることはパスの存在確認にならない (soft 404)。
 * 配信できなければ null を返す (呼び出し元が 404 にする)。
 */
async function serveClientAsset(
  pathname: string,
  method: string,
  accept: string | undefined,
  clientDistDir: string,
): Promise<Response | null> {
  if (pathname !== "/" && !pathname.startsWith("/")) return null;
  const relativePath = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
  const filePath = resolve(clientDistDir, relativePath);
  // client/dist の外は絶対に配信しない (traversal guard)。フォールバックにも回さない
  if (filePath !== clientDistDir && !filePath.startsWith(clientDistDir + sep)) return null;

  const result = await readDistFile(filePath);
  if (result.kind === "ok") return staticFileResponse(result.body, relativePath);
  // 未ビルドなら案内を出し、それ以外は 404 にする。
  if (relativePath === "index.html") return result.kind === "missing" ? clientBuildMissingResponse() : null;
  if (result.kind === "error") return null;

  if (!isSpaFallback(pathname, method, accept)) return null;
  const index = await readDistFile(resolve(clientDistDir, "index.html"));
  if (index.kind === "ok") return staticFileResponse(index.body, "index.html");
  return index.kind === "missing" ? clientBuildMissingResponse() : null;
}

/**
 * SPA の画面 URL として index.html を返す要求か。拡張子なしの GET / HEAD だけを対象にする
 * (`/foo.txt` や `/assets/missing` は「無いファイル」なので 404 のまま。HTML 200 は画面 URL に限る)。
 */
function isSpaFallback(pathname: string, method: string, accept: string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!acceptsHtml(accept)) return false;
  // 除外判定は decode 済みのパスで行う (%2F で /api や /assets の境界を迂回させない)
  if (FALLBACK_EXCLUDED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return false;
  }
  // dotfile と末尾ドットは対象外。末尾スラッシュは最後の非空セグメントで判断する
  const lastSegment = pathname.split("/").filter(Boolean).at(-1);
  return lastSegment !== undefined && !lastSegment.includes(".");
}

/**
 * `Accept` に `text/html` が q>0 で含まれるか。部分文字列で見ないのは `text/html;q=0` を除くため。
 * ワイルドカードだけの指定は画面遷移を名乗っていない (ブラウザーは必ず text/html を明示する) ので対象外にする。
 */
function acceptsHtml(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(",").some((entry) => {
    const [mediaType, ...params] = entry.split(";");
    if (mediaType.trim().toLowerCase() !== "text/html") return false;
    const quality = params.find((param) => param.split("=")[0]?.trim().toLowerCase() === "q");
    return quality === undefined || Number(quality.split("=")[1]?.trim()) > 0;
  });
}

type DistFile = { kind: "ok"; body: Buffer } | { kind: "missing" } | { kind: "error" };

/** 未ビルドの判断に使うため「無い (ENOENT / ENOTDIR)」と「読めない」を区別する */
async function readDistFile(filePath: string): Promise<DistFile> {
  try {
    return { kind: "ok", body: await readFile(filePath) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "error" };
  }
}

function staticFileResponse(body: Buffer, relativePath: string): Response {
  // Vite はハッシュ付きファイルを assets/ 配下に出すため長期キャッシュ、それ以外は no-cache。
  // キャッシュは要求された URL ではなく実際に配信するファイルで決める (フォールバックの index.html は no-cache)。
  const isHashedAsset = relativePath.startsWith("assets/");
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": CONTENT_TYPES[extname(relativePath)] ?? "application/octet-stream",
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": STATIC_CSP,
    },
  });
}
