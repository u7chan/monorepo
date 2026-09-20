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
 * 読み込めるのはインラインの style / script と data: / blob: の埋め込みだけにする。
 * 親 (client/dist) の CSP を継承させると iframe 内で何も動かないため、この応答だけ別の規則にする (docs/file-preview.md)。
 */
const HTML_PREVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'";

/** プレビューの応答は本文もエラーも常に no-store (一覧の再読み込みで取り直す前提)。 */
const HTML_PREVIEW_HEADERS = {
  "Content-Security-Policy": HTML_PREVIEW_CSP,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
     * HTML を描画するための本文 (iframe の src)。取得は iframe に任せるので、client は URL を組み立てるだけになる。
     * 拡張子は見ない (HTML として開くかの判断は client が持ち、ここは常に text/html として返す)。
     */
    html: async (c: Context) => {
      if (!workspace) return htmlError(c, 503, SANDBOX_NOT_CONFIGURED_MESSAGE);
      try {
        // 本文はテキストプレビューと同じ経路 (サンドボックスの GET /v1/files/preview、UTF-8 テキスト 256 KiB 上限)
        const parsed = FilePreviewSchema.safeParse(await workspace.previewFile(c.req.query("path") ?? ""));
        if (!parsed.success) return htmlError(c, 502, "サンドボックスのプレビューが不正です");
        return c.html(parsed.data.text, 200, HTML_PREVIEW_HEADERS);
      } catch (error) {
        return htmlError(c, sandboxFailureStatus(error), messageFor(error));
      }
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
    /**
     * 画像の生配信 (チャットのサムネイル / ファイル画面のプレビュー)。allowlist を BFF でも見て、
     * 画像以外を同一オリジンで配らない (SVG / HTML の XSS 回避)。
     */
    raw: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      const path = c.req.query("path") ?? "";
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
    },
  };
}
