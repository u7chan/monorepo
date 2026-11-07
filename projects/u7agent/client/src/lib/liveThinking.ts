/**
 * 実行中の thinking 末尾の表示規則。状態行の下の 2 行領域に収める文字列だけを作る
 * (見た目と高さは `client/src/styles/index.css` の `.live-thought` が持つ)。
 */

/** 2 行領域に収める末尾の行数 */
export const THINKING_SNIPPET_LINES = 2;
/** 2 行領域に収める最大 code point。超えたら先頭を `…` にする */
export const THINKING_SNIPPET_CHARS = 160;

/**
 * 空行を除いた末尾 2 行を、160 code point までに切る。サロゲートペアは割らない
 * (11px の本文を 2 行で読み切れる長さに保ち、テキスト量で高さを変えないため)。
 */
export function liveThoughtSnippet(text: string): string {
  const lines = text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    return trimmed === "" ? [] : [trimmed];
  });
  const tail = lines.slice(-THINKING_SNIPPET_LINES).join("\n");
  const points = Array.from(tail);
  if (points.length <= THINKING_SNIPPET_CHARS) return tail;
  return `…${points.slice(points.length - (THINKING_SNIPPET_CHARS - 1)).join("")}`;
}
