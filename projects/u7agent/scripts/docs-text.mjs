/**
 * docs の本文から「散文」だけを取り出す純関数。どこまでが散文かは Markdown の解釈で決まるため、
 * 本文のリンク検査と冒頭段落の検査は必ずこの module を通す（規則を 2 箇所に分けない）。
 */

/** 行内のコード span を落とす。バッククォートが奇数個の行は対応を決められないので触らない。 */
export function withoutInlineCode(text) {
  return text
    .split("\n")
    .map((line) =>
      (line.match(/`/g)?.length ?? 0) % 2 === 0 ? line.replace(/`[^`\n]*`/g, "") : line,
    )
    .join("\n");
}

const HEADING = /^#{1,6}(?:[ \t]|$)/;
const THEMATIC = /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const SETEXT = /^(?:=+|-{1,2})[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})/;
const MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;

/** コンテナの内容位置からブロックを開始できるのは 3 桁まで。深い行は段落の継続かコード。 */
const INDENT = 3;

/** 表の行のセル。外側の `|` は落とし、`\|` は区切りにしない。 */
function tableCells(line) {
  return line
    .trim()
    .replace(/\\\|/g, "")
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
}

/** GFM の表の区切り行か (`| --- | :-: |` など)。 */
function isTableDelimiter(line) {
  return line.includes("|") && tableCells(line).every((cell) => DELIMITER_CELL.test(cell));
}

/** フェンスの閉じ行か。記号は開きと同じで、長さは開き以上。 */
function isFenceEnd(line, fence) {
  const match = /^(`{3,}|~{3,})$/.exec(line.trim());
  return match !== null && match[1][0] === fence[0] && match[1].length >= fence.length;
}

/**
 * 行を散文 / コードと、その行のコンテナ内容インデントに分類する。フェンス・インデントコード・
 * 段落の開閉が同じコンテナ状態に依存するので、判定を分けると片方だけが腐る。
 */
function classify(text) {
  const rows = [];
  const items = [];
  let paragraph = null;
  let paragraphBody = "";
  let paragraphLines = 0;
  let table = false;
  let fence = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      rows.push({ line, code: true, contentIndent: 0 });
      if (isFenceEnd(line, fence)) fence = null;
      continue;
    }
    if (line.trim() === "") {
      rows.push({ line, code: false, contentIndent: 0 });
      paragraph = null;
      table = false;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (items.length > 0 && items[items.length - 1] > indent) items.pop();
    const contentIndent = items.length > 0 ? items[items.length - 1] : 0;
    const relative = indent - contentIndent;
    const content = line.trimStart();
    const atBlockIndent = relative >= 0 && relative <= INDENT;
    const open = atBlockIndent ? FENCE.exec(content) : null;
    if (open !== null) {
      fence = open[1];
      paragraph = null;
      table = false;
      rows.push({ line, code: true, contentIndent });
      continue;
    }
    const marker = MARKER.exec(line);
    // リスト項目はコンテナの内容位置から 3 桁以内でだけ始まる
    const listItem =
      marker !== null &&
      marker[1].length - contentIndent >= 0 &&
      marker[1].length - contentIndent <= INDENT;
    const heading = atBlockIndent && HEADING.test(content);
    const thematic = atBlockIndent && THEMATIC.test(content);
    // インデントコードは段落を中断できない (空行か、段落のないブロックの後だけが開始できる)
    if (paragraph === null && relative > INDENT) {
      table = false;
      rows.push({ line, code: true, contentIndent });
      continue;
    }
    // 表は空行か別のブロックの開始まで続き、その行は段落を開かない (GFM の表は leaf block)
    if (table && !heading && !thematic && !listItem) {
      rows.push({ line, code: false, contentIndent });
      continue;
    }
    table = false;
    // 見出し行は 1 行の段落で、区切り行と列数が一致し、段落の内容位置から 3 桁以内のときだけ表になる
    const inParagraph =
      paragraph !== null && indent - paragraph >= 0 && indent - paragraph <= INDENT;
    if (
      inParagraph &&
      paragraphLines === 1 &&
      isTableDelimiter(content) &&
      tableCells(paragraphBody).length === tableCells(content).length
    ) {
      table = true;
      paragraph = null;
      rows.push({ line, code: false, contentIndent });
      continue;
    }
    if (heading || thematic) {
      paragraph = null;
      rows.push({ line, code: false, contentIndent });
      continue;
    }
    // setext の下線は開いている段落を閉じる。lazy continuation は下線にできないので、
    // 段落の内容位置より浅い行では閉じない
    if (inParagraph && SETEXT.test(content)) {
      paragraph = null;
      rows.push({ line, code: false, contentIndent });
      continue;
    }
    if (listItem) {
      const body = marker[4].trim();
      const itemIndent = marker[1].length + marker[2].length + marker[3].length;
      items.push(itemIndent);
      paragraphBody = body;
      paragraphLines = 1;
      // 項目の中身が空か見出しか水平線なら、その項目の段落は開かない
      paragraph = body === "" || HEADING.test(body) || THEMATIC.test(body) ? null : itemIndent;
      rows.push({ line, code: false, contentIndent: itemIndent });
      continue;
    }
    if (paragraph === null) {
      paragraph = contentIndent;
      paragraphBody = content;
      paragraphLines = 1;
    } else {
      paragraphLines += 1;
    }
    rows.push({ line, code: false, contentIndent });
  }
  return rows;
}

/** コード (フェンスとインデントコード) を落とす。境界の判定は `classify` が持つ。 */
export function withoutCode(text) {
  return classify(text)
    .filter((row) => !row.code)
    .map((row) => row.line)
    .join("\n");
}

/** コード例の中の記法は参照ではないので、リンク検査の前に落とす。 */
export function proseOf(text) {
  return withoutInlineCode(withoutCode(text));
}

const HTML_BLOCK_TAGS =
  "address|article|aside|audio|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul";

/** 行頭の生の HTML ブロックか (CommonMark の 1〜7 型)。タグ名は大文字小文字を区別しない。 */
const HTML_BLOCK = new RegExp(
  `^ {0,3}<(?:!--|\\?|![A-Za-z\\[]|\\/?(?:${HTML_BLOCK_TAGS})(?:[ \\t/>]|$)|\\/?[A-Za-z][A-Za-z0-9-]*(?:[ \\t][^<>]*)?\\/?>[ \\t]*$)`,
  "i",
);

/** 散文の境界を決められない構文。`docs/` では使わない規約にし、検出したら失敗させる。 */
const UNSUPPORTED = [
  { syntax: "quote", pattern: /^ {0,3}>/ },
  { syntax: "html", pattern: HTML_BLOCK },
];

/**
 * 境界を決められない構文の位置を返す。推測して落とすと正しい参照を消し、推測して残すと
 * コード例の中身を実リンクとして検証するので、どちらにも倒さず規約違反として報告する。
 */
export function unsupportedBlocks(text) {
  return classify(text).flatMap((row, index) => {
    if (row.code) return [];
    const hit = UNSUPPORTED.find(({ pattern }) => pattern.test(row.line.slice(row.contentIndent)));
    return hit === undefined ? [] : [{ line: index + 1, syntax: hit.syntax }];
  });
}

/** リンクの参照先。title (`[t](url "title")`) と angle (`[t](<url>)`) も GitHub の記法として通す。 */
export const linkPattern =
  /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
