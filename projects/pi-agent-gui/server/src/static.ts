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

const STATIC_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'";

export function serveClientAssets(clientDistDir: string) {
  return async (c: Context) => {
    let pathname = c.req.path;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    const response = await serveStaticPath(pathname, clientDistDir);
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

/** 配信できなければ null を返す (呼び出し元が 404 にする)。 */
async function serveStaticPath(pathname: string, clientDistDir: string): Promise<Response | null> {
  if (pathname !== "/" && !pathname.startsWith("/")) return null;
  const relativePath = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
  const filePath = resolve(clientDistDir, relativePath);
  // client/dist の外は絶対に配信しない (traversal guard)
  if (filePath !== clientDistDir && !filePath.startsWith(clientDistDir + sep)) return null;

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch (error) {
    // 未ビルドなら案内を出し、それ以外は 404 にする。
    const code = (error as NodeJS.ErrnoException).code;
    if (relativePath === "index.html" && (code === "ENOENT" || code === "ENOTDIR")) {
      return clientBuildMissingResponse();
    }
    return null;
  }

  // Vite はハッシュ付きファイルを assets/ 配下に出すため長期キャッシュ、それ以外は no-cache。
  const isHashedAsset = relativePath.startsWith("assets/");
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": STATIC_CSP,
    },
  });
}
