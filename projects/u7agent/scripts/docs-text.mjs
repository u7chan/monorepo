/**
 * docs の本文から「散文」だけを取り出す純関数。どこまでが散文かは Markdown の解釈で決まるため、
 * 本文のリンク検査と冒頭段落の検査は必ずこの module を通す（規則を 2 箇所に分けない）。
 */

/** fenced code block を落とす。GitHub は ``` と ~~~ の両方をフェンスとして描画する。 */
export function withoutCodeBlocks(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
}

/** 行内のコード span を落とす。バッククォートが奇数個の行は対応を決められないので触らない。 */
export function withoutInlineCode(text) {
  return text
    .split("\n")
    .map((line) =>
      (line.match(/`/g)?.length ?? 0) % 2 === 0 ? line.replace(/`[^`\n]*`/g, "") : line,
    )
    .join("\n");
}

const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;

/**
 * 行頭 4 スペース以上のインデントコードを落とす。段落の継続行は散文のままとし、
 * リストの内容は「内容のインデント + 4」からをコードとして扱う。
 */
export function withoutIndentedCode(text) {
  const out = [];
  const listStack = [];
  let paragraph = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      out.push(line);
      paragraph = false;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (listStack.length > 0 && listStack[listStack.length - 1] > indent) listStack.pop();
    const codeAt = (listStack.length > 0 ? listStack[listStack.length - 1] : 0) + 4;
    // インデントコードは段落を中断できない（空行の次だけが開始できる）
    if (!paragraph && indent >= codeAt) continue;
    const marker = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line);
    if (marker !== null && indent < codeAt) {
      listStack.push(marker[1].length + marker[2].length + marker[3].length);
      paragraph = marker[4].trim() !== "";
      out.push(line);
      continue;
    }
    paragraph = !HEADING.test(line) && !THEMATIC.test(line);
    out.push(line);
  }
  return out.join("\n");
}

/** コード例の中の記法は参照ではないので、リンク検査の前に落とす。 */
export function proseOf(text) {
  return withoutInlineCode(withoutIndentedCode(withoutCodeBlocks(text)));
}

/** リンクの参照先。title (`[t](url "title")`) と angle (`[t](<url>)`) も GitHub の記法として通す。 */
export const linkPattern =
  /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
