/**
 * コードブロック / ファイル本文の行番号。チャット本文とファイルプレビューで同じ見た目と数え方に
 * なるよう、番号の文字列と行数だけをここで決める (描画は別列。契約は docs/markdown.md)。
 */

/**
 * 描画する本文の行数 (= 行番号の数)。末尾の改行 1 つに空の行は描かれないので数えず、本文が空の
 * ときだけ 0 行。`caret` は生成中のカーソルが次の行に載るとき、その行の番号も出す。
 */
export function codeLineCount(text: string, caret = false): number {
  if (caret && (text === "" || text.endsWith("\n"))) return codeLineCount(text) + 1;
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * 行番号の列 (1 から lineCount までを改行で繋いだ 1 つの文字列)。行ごとの要素も CSS カウンタも使わず、
 * 番号のために行数分の DOM を積まない。
 */
export function lineNumbers(lineCount: number): string {
  let numbers = "";
  for (let line = 1; line <= lineCount; line++) {
    if (line > 1) numbers += "\n";
    numbers += line;
  }
  return numbers;
}
