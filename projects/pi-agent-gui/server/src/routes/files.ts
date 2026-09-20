import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  messageFor,
  sandboxFailure,
  sandboxFailureStatus,
  sandboxNotConfigured,
  SANDBOX_NOT_CONFIGURED_MESSAGE,
} from "../http";
import { FileListingSchema, FilePreviewSchema } from "../schema";
import { rawImageContentType } from "../sandbox/protocol";
import type { SandboxWorkspaceClient } from "../sandbox/client";

/**
 * iframe へ流す HTML プレビューの CSP。iframe 側の `sandbox="allow-scripts"` と両方で隔離し、
 * 読み込めるリソースを段階 (Lv) で絞る。親 (client/dist) の CSP を継承させると iframe 内で何も動かないため、この応答だけ別の規則にする (docs/file-preview.md)。
 */
export type HtmlPreviewPolicy = "inline" | "assets" | "cdn";

/**
 * 適用するポリシー。既定は Lv2 (相対アセットの `'self'` と https: の外部 URL)。
 * `connect-src` はどの段階でも足さない (オペークオリジンでは fetch が読めず、増やすと POST の面だけ広がる)。
 */
export const HTML_PREVIEW_POLICY: HtmlPreviewPolicy = "cdn";

export const HTML_PREVIEW_CSP_BY_POLICY: Record<HtmlPreviewPolicy, string> = {
  inline:
    "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'",
  assets:
    "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data: 'self'; media-src data: blob: 'self'; form-action 'none'",
  cdn: "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self' https:; script-src 'unsafe-inline' 'self' https:; img-src data: blob: 'self' https:; font-src data: 'self' https:; media-src data: blob: 'self' https:; form-action 'none'",
};

/** プレビューの応答は本文もエラーも常に no-store (一覧の再読み込みで取り直す前提)。 */
const HTML_PREVIEW_HEADERS = {
  "Content-Security-Policy": HTML_PREVIEW_CSP_BY_POLICY[HTML_PREVIEW_POLICY],
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * プレビューの文書が相対参照するテキストアセットと Content-Type。HTML / SVG は同一オリジンでスクリプトが動くため載せず、
 * HTML は文書分岐、SVG は 400 にする (拡張子ごとの分岐は docs/file-preview.md)。
 */
const PREVIEW_ASSET_CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 拡張子を小文字で取る。拡張子なしと dotfile は undefined で、画像 allowlist と同じ規則。 */
function fileExtension(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
}

function isHtmlDocumentPath(path: string): boolean {
  const extension = fileExtension(path);
  return extension === "html" || extension === "htm";
}

function previewAssetContentType(path: string): string | undefined {
  const extension = fileExtension(path);
  // `Object.prototype` の名前 (`.constructor` など) を拡張子に使われても引かない
  if (!extension || !Object.hasOwn(PREVIEW_ASSET_CONTENT_TYPES, extension)) return undefined;
  return PREVIEW_ASSET_CONTENT_TYPES[extension];
}

/** iframe の中でも理由が読めるように、エラーも HTML 文書で返す (サンドボックス由来の文言はエスケープする)。 */
function htmlError(c: Context, status: number, message: string) {
  const body = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>プレビューできません</title>
</head>
<body style="padding: 12px; font-family: system-ui, sans-serif; font-size: 13px; color: #333">
<p>プレビューできません (HTTP ${status})</p>
<p>${escapeHtml(message)}</p>
</body>
</html>
`;
  return c.html(body, status as ContentfulStatusCode, HTML_PREVIEW_HEADERS);
}

/** セッションに依存させない (セッションが無くても開ける必要がある) ため、トップレベルのルートにする。 */
export function createFileRoutes({ workspace }: { workspace: SandboxWorkspaceClient | null }) {
  /** 画像は allowlist を BFF でも見て、画像以外を同一オリジンで配らない (SVG / HTML の XSS 回避)。 */
  async function serveRawImage(c: Context, path: string) {
    if (!workspace) return sandboxNotConfigured(c);
    if (!rawImageContentType(path)) return c.json({ error: `Not a servable image: ${path}` }, 400);
    try {
      const file = await workspace.rawFile(path);
      if (!file.body) return c.json({ error: "サンドボックスが本文を返しませんでした" }, 502);
      return c.body(file.body, 200, {
        "Content-Type": file.contentType,
        ...(file.contentLength === undefined ? {} : { "Content-Length": String(file.contentLength) }),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  }

  /**
   * テキストアセットは本文を `text/html` として解釈させない。拡張子の Content-Type と nosniff を付けて返し、
   * エラーは iframe の中で HTML 文書として解釈されないよう JSON で返す。
   */
  async function serveTextAsset(c: Context, path: string, contentType: string) {
    if (!workspace) return sandboxNotConfigured(c);
    try {
      // 本文はテキストプレビューと同じ経路 (サンドボックスの GET /v1/files/preview、UTF-8 テキスト 256 KiB 上限)
      const parsed = FilePreviewSchema.safeParse(await workspace.previewFile(path));
      if (!parsed.success) return c.json({ error: "サンドボックスのプレビューが不正です" }, 502);
      return c.body(parsed.data.text, 200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (error) {
      return sandboxFailure(c, error);
    }
  }

  /** 文書分岐の失敗は iframe に読ませるため HTML 文書で返す (エラーだけは HTML のまま)。 */
  async function serveHtmlDocument(c: Context, path: string) {
    if (!workspace) return htmlError(c, 503, SANDBOX_NOT_CONFIGURED_MESSAGE);
    try {
      // 本文はテキストプレビューと同じ経路 (サンドボックスの GET /v1/files/preview、UTF-8 テキスト 256 KiB 上限)
      const parsed = FilePreviewSchema.safeParse(await workspace.previewFile(path));
      if (!parsed.success) return htmlError(c, 502, "サンドボックスのプレビューが不正です");
      return c.html(parsed.data.text, 200, HTML_PREVIEW_HEADERS);
    } catch (error) {
      return htmlError(c, sandboxFailureStatus(error), messageFor(error));
    }
  }

  return {
    preview: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      try {
        const parsed = FilePreviewSchema.safeParse(await workspace.previewFile(c.req.query("path") ?? ""));
        if (!parsed.success) return c.json({ error: "サンドボックスのプレビューが不正です" }, 502);
        c.header("Cache-Control", "no-store");
        return c.json(parsed.data);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },
    /**
     * HTML を描画するための本文と、その文書が相対参照するアセット (iframe の src)。同じルートを拡張子で分岐させ、
     * 文書と同じディレクトリを基準に `.js` や画像を解決できるようにする。取得は iframe に任せるので、client は URL を組み立てるだけになる。
     */
    html: async (c: Context) => {
      // `:path{.+}` は Hono が 1 回だけ percent decoding する (path に空文字は来ない)
      const path = c.req.param("path") ?? "";
      if (isHtmlDocumentPath(path)) return serveHtmlDocument(c, path);
      if (rawImageContentType(path)) return serveRawImage(c, path);
      const contentType = previewAssetContentType(path);
      if (!contentType) return c.json({ error: `Not a servable asset: ${path}` }, 400);
      return serveTextAsset(c, path, contentType);
    },
    list: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      const path = c.req.query("path") ?? ".";
      let listing: unknown;
      try {
        listing = await workspace.listFiles(path);
      } catch (error) {
        return sandboxFailure(c, error);
      }
      const parsed = FileListingSchema.safeParse(listing);
      if (!parsed.success) {
        return c.json({ error: "サンドボックスのファイル一覧が不正です" }, 502);
      }
      return c.json(parsed.data);
    },
    /**
     * 通常ファイルの削除 (チャット右パネルのファイル一覧から誤アップロードを取り消す導線)。
     * パス検証 (root 外 400 / 不存在 404 / 通常ファイル以外 400 / symlink 400) と削除はサンドボックスが行う。
     */
    remove: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      try {
        await workspace.deleteFile(c.req.query("path") ?? "");
        return c.body(null, 204);
      } catch (error) {
        return sandboxFailure(c, error);
      }
    },
    /** 画像の生配信 (チャットのサムネイル / ファイル画面のプレビュー)。 */
    raw: async (c: Context) => serveRawImage(c, c.req.query("path") ?? ""),
  };
}
