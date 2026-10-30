/**
 * docs の本文から「散文」だけを取り出す純関数。
 *
 * docs:check は散文の中のリンクとパスを検査する。どこまでが散文かは Markdown を解釈しないと
 * 決まらないため、ここで落とし方を固定する。推測を外すと、正しい参照を消して拒否するか、
 * コード例の中の参照を実リンクとして検証するかのどちらかになる。
 * 副作用を持たないので、境界は server/test/docs-text.test.ts で固定する。
 */

/** fenced code block を落とす。GitHub は ``` と ~~~ の両方をフェンスとして描画する。 */
export function withoutCodeBlocks(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
}

/**
 * 行内のコード span を落とす。バッククォートが奇数個の行はどれが対応するか決められないので、
 * その行は触らない（対応を推測して消すと、本文のリンクまで飲み込む）。
 */
export function withoutInlineCode(text) {
  return text
    .split("\n")
    .map((line) =>
      (line.match(/`/g)?.length ?? 0) % 2 === 0 ? line.replace(/`[^`\n]*`/g, "") : line,
    )
    .join("\n");
}

/**
 * 行頭 4 スペース以上で始まる行をコードブロックとして落とす。ただしリストの内容は
 * 「内容のインデント + 4」からがコードなので、リストの継続は散文として残す。
 */
export function withoutIndentedCode(text) {
  const out = [];
  let contentIndent = 0;
  let inList = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const marker = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/.exec(line);
    if (marker !== null) {
      contentIndent = marker[1].length + marker[2].length + marker[3].length;
      inList = true;
      out.push(line);
      continue;
    }
    if (indent === 0) {
      inList = false;
      contentIndent = 0;
    }
    if (indent >= (inList ? contentIndent : 0) + 4) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** コード例の中の記法は参照ではないので、リンク検査の前に落とす。 */
export function proseOf(text) {
  return withoutInlineCode(withoutIndentedCode(withoutCodeBlocks(text)));
}

/**
 * リンクの参照先。title (`[t](url "title")`) と angle (`[t](<url with space>)`) も GitHub の記法として通す。
 * ここを狭めると、その形式で書いたリンクが無検査で残る。
 */
export const linkPattern =
  /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
