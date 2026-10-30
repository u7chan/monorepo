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
const CLOSING_FENCE = /^(`{3,}|~{3,})$/;
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

/** 行頭のリストマーカーをすべて落とす。1 行で複数の項目が始まることがある。 */
function stripMarkers(content) {
  let body = content;
  let width = 0;
  for (let match = MARKER.exec(body); match !== null; match = MARKER.exec(body)) {
    width += match[1].length + match[2].length + match[3].length;
    body = match[4];
  }
  return { body, width };
}

/** フェンスの閉じ行か。記号は開きと同じで、長さは開き以上、コンテナから 3 桁まで。 */
function isFenceEnd(line, fence) {
  const mark = CLOSING_FENCE.exec(line.trim());
  const relative = line.length - line.trimStart().length - fence.indent;
  return (
    mark !== null &&
    relative >= 0 &&
    relative <= INDENT &&
    mark[1][0] === fence.mark[0] &&
    mark[1].length >= fence.mark.length
  );
}

/**
 * 行を散文 / コードと、その行の本文（リストマーカーを落とした内容）に分類する。フェンス・
 * インデントコード・段落の開閉が同じコンテナ状態に依存するので、判定を分けると片方だけが腐る。
 */
function classify(text) {
  const rows = [];
  const items = [];
  let paragraph = null;
  let paragraphBody = "";
  let table = false;
  let fence = null;
  for (const line of text.split("\n")) {
    const paragraphBefore = paragraph !== null;
    if (fence !== null) {
      rows.push({ line, code: true, body: "", blockIndent: false, continues: paragraphBefore });
      if (isFenceEnd(line, fence)) fence = null;
      continue;
    }
    if (line.trim() === "") {
      rows.push({ line, code: false, body: "", blockIndent: false, continues: false });
      paragraph = null;
      table = false;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (items.length > 0 && items[items.length - 1] > indent) items.pop();
    const contentIndent = items.length > 0 ? items[items.length - 1] : 0;
    const relative = indent - contentIndent;
    const blockIndent = relative <= INDENT;
    const content = line.trimStart();
    const marker = blockIndent ? MARKER.exec(content) : null;
    // 段落の中では、内容のある「-」「*」「+」と 1 から始まる番号付きだけが項目を開始できる
    const interrupts =
      marker === null ||
      !paragraphBefore ||
      (marker[4].trim() !== "" && (marker[2].length === 1 || /^1[.)]$/.test(marker[2])));
    const { body, width } =
      marker !== null && interrupts ? stripMarkers(content) : { body: content, width: 0 };
    const bodyIndent = indent + width;
    const open = blockIndent ? FENCE.exec(body) : null;
    if (open !== null) {
      fence = { mark: open[1], indent: width > 0 ? bodyIndent : contentIndent };
      // 項目の内容として始まったフェンスは、フェンスの間も項目を開いたままにする
      if (width > 0) items.push(bodyIndent);
      paragraph = null;
      table = false;
      rows.push({ line, code: true, body, blockIndent, continues: false });
      continue;
    }
    const heading = blockIndent && HEADING.test(body);
    const thematic = blockIndent && THEMATIC.test(body);
    const listItem = blockIndent && width > 0;
    // 段落の継続行は、HTML の 7 型のように段落を中断できないブロックを開始しない
    const continues = paragraphBefore && !heading && !thematic && !listItem;
    // インデントコードは段落を中断できない (空行か、段落のないブロックの後だけが開始できる)
    if (paragraph === null && !blockIndent) {
      table = false;
      rows.push({ line, code: true, body, blockIndent, continues });
      continue;
    }
    // 表は空行か別のブロックの開始まで続き、その行は段落を開かない (GFM の表は leaf block)
    if (table && !heading && !thematic && !listItem) {
      rows.push({ line, code: false, body, blockIndent, continues });
      continue;
    }
    table = false;
    // 表の見出しは直前の段落の最終行。区切り行と列数が一致し、段落の内容位置から 3 桁以内で成立する
    const inParagraph =
      paragraph !== null && indent - paragraph >= 0 && indent - paragraph <= INDENT;
    if (
      inParagraph &&
      isTableDelimiter(body) &&
      tableCells(paragraphBody).length === tableCells(body).length
    ) {
      table = true;
      paragraph = null;
      rows.push({ line, code: false, body, blockIndent, continues });
      continue;
    }
    if (heading || thematic) {
      paragraph = null;
      rows.push({ line, code: false, body, blockIndent, continues });
      continue;
    }
    // setext の下線は開いている段落を閉じる。lazy continuation は下線にできないので、
    // 段落の内容位置より浅い行では閉じない
    if (inParagraph && SETEXT.test(body)) {
      paragraph = null;
      rows.push({ line, code: false, body, blockIndent, continues });
      continue;
    }
    if (listItem) {
      items.push(bodyIndent);
      paragraphBody = body;
      // 項目の中身が空か見出しか水平線なら、その項目の段落は開かない
      paragraph = body === "" || HEADING.test(body) || THEMATIC.test(body) ? null : bodyIndent;
      rows.push({ line, code: false, body, blockIndent, continues });
      continue;
    }
    paragraphBody = body;
    if (paragraph === null) paragraph = contentIndent;
    rows.push({ line, code: false, body, blockIndent, continues });
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

/**
 * 行頭の生の HTML ブロックか (CommonMark の 1〜6 型)。段落を中断できる。
 * タグ名は大文字小文字を区別しない。
 */
const HTML_BLOCK = new RegExp(
  `^<(?:!--|\\?|![A-Za-z\\[]|\\/?(?:${HTML_BLOCK_TAGS})(?:[ \\t/>]|$))`,
  "i",
);

/** 完全なタグだけの行 (7 型)。属性値の中の `>` は許すが、段落は中断できない。 */
const HTML_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+(?:[^"'<>]|"[^"]*"|'[^']*')*)?[ \t]*\/?>[ \t]*$/;

/** 散文の境界を決められない構文。`docs/` では使わない規約にし、検出したら失敗させる。 */
const UNSUPPORTED = [
  { syntax: "quote", pattern: /^>/, interruptsParagraph: true },
  { syntax: "html", pattern: HTML_BLOCK, interruptsParagraph: true },
  { syntax: "html", pattern: HTML_TAG, interruptsParagraph: false },
];

/**
 * 境界を決められない構文の位置を返す。推測して落とすと正しい参照を消し、推測して残すと
 * コード例の中身を実リンクとして検証するので、どちらにも倒さず規約違反として報告する。
 */
export function unsupportedBlocks(text) {
  return classify(text).flatMap((row, index) => {
    if (row.code || !row.blockIndent) return [];
    const hit = UNSUPPORTED.find(
      ({ pattern, interruptsParagraph }) =>
        (interruptsParagraph || !row.continues) && pattern.test(row.body),
    );
    return hit === undefined ? [] : [{ line: index + 1, syntax: hit.syntax }];
  });
}

/** リンクの参照先。title (`[t](url "title")`) と angle (`[t](<url>)`) も GitHub の記法として通す。 */
export const linkPattern =
  /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
