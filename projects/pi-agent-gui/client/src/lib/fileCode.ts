/**
 * ファイルプレビュー本文の描画用モデル。行番号は描画側が本文と同じ行送りの別列として作るため、
 * ここでは本文の正規化・行数・言語判定・ハイライトだけを決める (DOM に依存させない)。
 * パイプラインと上限の理由は docs/file-preview.md を参照する。
 */
import { highlightCode, normalizeLang, type MdToken } from "./markdown/highlight";

/** ハイライトする本文の上限。サンドボックスが返す本文の上限 (256 KiB) に合わせる */
export const FILE_PREVIEW_MAX_LENGTH = 256 * 1024;

/**
 * 作るトークンの上限。トークン 1 つが DOM ノード 1 つになるので、描画コストはトークン数で決まる。
 * 値の根拠 (実測) は docs/file-preview.md を参照する。
 */
export const FILE_PREVIEW_MAX_TOKENS = 20 * 1000;

export type PreviewCode = {
  /** 行番号を付けて描画する本文。CRLF / CR は LF に揃え、末尾の空行は落とす */
  text: string;
  /** text の行数。空のファイルは 0 */
  lineCount: number;
  /** ハイライト結果。null は素のテキストとして描画する */
  highlight: { lang: string; tokens: MdToken[] } | null;
};

export function buildPreviewCode(text: string, path: string): PreviewCode {
  // CRLF の本文をそのまま出すと行末に CR が残り、行数とコピー内容がずれる。
  // 末尾の空行は本文からも行番号からも落とす (CSS の末尾の改行の扱いに頼らず 1 行 1 番号にするため)
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const lang = previewLang(path);
  const tokens = lang === null ? null : highlightCode(normalized, lang, FILE_PREVIEW_MAX_LENGTH);
  const highlight =
    lang === null || tokens === null || tokens.length > FILE_PREVIEW_MAX_TOKENS ? null : { lang, tokens };
  return { text: normalized, lineCount: normalized === "" ? 0 : normalized.split("\n").length, highlight };
}

/**
 * 拡張子から言語を決める。判定できないファイルは素のテキスト (null)。
 * 拡張子を持たないファイルは Dockerfile だけ bash の規則で色を付ける。
 */
export function previewLang(path: string): string | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0) return normalizeLang(name.slice(dot + 1));
  return name === "dockerfile" ? "bash" : null;
}

/**
 * 行番号の列 (1 から lineCount までを改行で繋いだ 1 つの文字列)。本文と同じ行送りの列として出すため、
 * 行ごとの要素は作らない (行数分の DOM を積まない)。
 */
export function previewLineNumbers(lineCount: number): string {
  let numbers = "";
  for (let line = 1; line <= lineCount; line++) {
    if (line > 1) numbers += "\n";
    numbers += line;
  }
  return numbers;
}

/**
 * プレビューで描画する対象か。拡張子の判定は previewLang と同じ規則 (ドットファイルは拡張子と見なさない) で、
 * `.xhtml` / `.svg` は対象外にする。自己完結した HTML だけを描画する方針 (docs/file-preview.md)。
 */
export function isHtmlPath(path: string): boolean {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1);
  return extension === "html" || extension === "htm";
}
