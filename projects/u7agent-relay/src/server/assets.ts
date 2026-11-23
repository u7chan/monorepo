import type { UpstreamMessage } from "./upstream";

export type AssetKind = "image" | "audio" | "html" | "text";

export type RunAsset = {
  path: string;
  kind: AssetKind;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "ogg", "oga", "wav", "flac"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "css", "js", "mjs"]);

export const MAX_RUN_ASSETS = 50;

/** Markdown のリンク先だけを拾う。生 HTML の `<img>` は対象にしない。 */
const MARKDOWN_DESTINATION = /!?\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/**
 * cwd 相対のパスとして受け付けられる形へ正規化する。`..` は畳まずに拒否し、
 * 先頭の `./` と重複する `/` / `.` セグメントだけを落とす。
 */
export function normalizeFilePath(raw: string): string | null {
  if (raw === "" || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    return null;
  }

  if (/\s/.test(raw) || raw.includes("?") || raw.includes("#") || raw.includes("://")) {
    return null;
  }

  const segments: string[] = [];

  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      return null;
    }

    segments.push(segment);
  }

  return segments.length === 0 ? null : segments.join("/");
}

/** セッションの cwd は root 相対。root 自身（`""` / `.`）はファイル API の対象外にする。 */
export function normalizeCwd(raw: unknown): string | null {
  return typeof raw === "string" ? normalizeFilePath(raw) : null;
}

export function assetKindOf(path: string): AssetKind | null {
  const dot = path.lastIndexOf(".");

  if (dot <= 0) {
    return null;
  }

  const extension = path.slice(dot + 1).toLowerCase();

  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (TEXT_EXTENSIONS.has(extension)) return "text";

  return null;
}

/**
 * その run の assistant 本文に現れた生成物だけを拾う。存在確認はしない。
 * 完了時の投影から作るため、圧縮で落ちた前半のメッセージは対象にできない。
 */
export function extractRunAssets(messages: UpstreamMessage[] | undefined, runId: string): RunAsset[] {
  const prefix = `${runId}:`;
  const seen = new Set<string>();
  const assets: RunAsset[] = [];

  for (const message of messages ?? []) {
    if (message.role !== "assistant" || !message.assistantId?.startsWith(prefix) || !message.text) {
      continue;
    }

    for (const match of stripCode(message.text).matchAll(MARKDOWN_DESTINATION)) {
      const path = normalizeFilePath(match[1] ?? match[2] ?? "");

      if (path === null || seen.has(path)) {
        continue;
      }

      const kind = assetKindOf(path);

      if (kind === null) {
        continue;
      }

      seen.add(path);
      assets.push({ path, kind });

      if (assets.length >= MAX_RUN_ASSETS) {
        return assets;
      }
    }
  }

  return assets;
}

/** コードブロック・インラインコードの中の字面をリンクとして拾わない。 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}
