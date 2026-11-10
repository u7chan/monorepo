/**
 * SVG のプレビュー用 data URL。本文はタブごとに保持した文字列をそのまま使い、サーバーに別ルートを増やさない
 * (理由は docs/file-preview.md#svg-プレビュー)。
 */

/** String.fromCharCode の引数上限に当たらないよう、base64 へ渡す前に分けるバイト数 */
const BASE64_CHUNK_BYTES = 0x8000;

/**
 * 本文を `<img>` の src に渡す data URL にする。base64 にするのは、percent encoding が非 ASCII で
 * 最大 9 倍に膨らむため (本文は 2 MiB まで取得できる)。
 */
export function svgDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * プレビューで `<img>` に渡す URL。空白だけの本文は XML のルート要素を持たず、画像として読み込めないため
 * 空のファイルとして null を返す。
 */
export function svgPreviewUrl(text: string): string | null {
  return text.trim() === "" ? null : svgDataUrl(text);
}
