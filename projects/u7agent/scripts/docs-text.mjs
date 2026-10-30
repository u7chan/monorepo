/**
 * docs の本文から「散文」だけを取り出す純関数。どこまでが散文かは Markdown の解釈で決まるため、
 * 本文のリンク検査と冒頭段落の検査は必ずこの module を通す（規則を 2 箇所に分けない）。
 */

const FENCE = /^(```|~~~)[\s\S]*?^\1/gm;

/** fenced code block を落とす。GitHub は ``` と ~~~ の両方をフェンスとして描画する。 */
export function withoutCodeBlocks(text) {
  return text.replace(FENCE, "");
}

/** フェンスの中身を空行に置き換える。中身を外しつつ、報告する行番号をずらさないため。 */
function blankCodeBlocks(text) {
  return text.replace(FENCE, (block) => "\n".repeat((block.match(/\n/g) ?? []).length));
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
// setext 見出しの下線。段落の次の行にだけ効く（単独なら「===」という段落）
const SETEXT = /^ {0,3}(?:=+|-{1,2})[ \t]*$/;
/** GFM の表の区切り行か。見出し行 (直前の段落) が `|` を含むことは別に確かめる。 */
function isTableDelimiter(line) {
  if (!line.includes("|")) return false;
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell));
}

/**
 * 行頭 4 スペース以上のインデントコードを落とす。段落の継続行は散文のままとし、
 * リストの内容は「内容のインデント + 4」からをコードとして扱う。
 * 段落を閉じる leaf block（見出し / 水平線 / setext 見出し / 表）は、直後のインデント行を
 * コードとして扱う。引用と HTML ブロックは中身のブロック構造を持つので扱わない
 * （docs では使わない規約。`unsupportedBlocks` が検出する）。
 */
export function withoutIndentedCode(text) {
  const out = [];
  const listStack = [];
  let paragraph = false;
  let table = false;
  let last = "";
  for (const line of text.split("\n")) {
    const previous = last;
    last = line;
    if (line.trim() === "") {
      out.push(line);
      paragraph = false;
      table = false;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (listStack.length > 0 && listStack[listStack.length - 1] > indent) listStack.pop();
    const codeAt = (listStack.length > 0 ? listStack[listStack.length - 1] : 0) + 4;
    const marker = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line);
    const blockStart =
      HEADING.test(line) || THEMATIC.test(line) || marker !== null || indent >= codeAt;
    // 表は空行か別のブロックの開始まで続く。表の行は段落ではないので、直後のインデント行はコード
    if (table && !blockStart) {
      out.push(line);
      continue;
    }
    table = false;
    // インデントコードは段落を中断できない（空行の次だけが開始できる）
    if (!paragraph && indent >= codeAt) continue;
    if (paragraph && previous.includes("|") && isTableDelimiter(line)) {
      table = true;
      paragraph = false;
      out.push(line);
      continue;
    }
    if (marker !== null && indent < codeAt) {
      listStack.push(marker[1].length + marker[2].length + marker[3].length);
      // 項目の中身が見出しや水平線なら、その項目の段落は開かない
      paragraph = marker[4].trim() !== "" && !HEADING.test(marker[4]) && !THEMATIC.test(marker[4]);
      out.push(line);
      continue;
    }
    // setext の下線は開いている段落を見出しにする（見出しも leaf block）
    const setext = paragraph && SETEXT.test(line);
    paragraph = !setext && !HEADING.test(line) && !THEMATIC.test(line);
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 行頭の生の HTML (CommonMark の HTML ブロック)。docs では使わない規約にする。中身の段落を
 * 持たず、直後のインデント行が散文かコードかを決められないため。
 */
const HTML_BLOCK =
  /^ {0,3}<(?:!--|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|audio|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|$))/;

/** 散文の境界を決められない構文。`docs/` では使わない規約にし、検出したら失敗させる。 */
const UNSUPPORTED = [
  { syntax: "quote", pattern: /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?>/ },
  { syntax: "html", pattern: HTML_BLOCK },
];

/**
 * 境界を決められない構文の位置を返す。推測して落とすと正しい参照を消し、推測して残すと
 * コード例の中身を実リンクとして検証するので、どちらにも倒さず規約違反として報告する。
 * フェンスの中と、行頭 4 スペース以上（インデントコード）は対象外。
 */
export function unsupportedBlocks(text) {
  return blankCodeBlocks(text)
    .split("\n")
    .flatMap((line, index) => {
      const hit = UNSUPPORTED.find(({ pattern }) => pattern.test(line));
      return hit === undefined ? [] : [{ line: index + 1, syntax: hit.syntax }];
    });
}

/** コード例の中の記法は参照ではないので、リンク検査の前に落とす。 */
export function proseOf(text) {
  return withoutInlineCode(withoutIndentedCode(withoutCodeBlocks(text)));
}

/** リンクの参照先。title (`[t](url "title")`) と angle (`[t](<url>)`) も GitHub の記法として通す。 */
export const linkPattern =
  /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
