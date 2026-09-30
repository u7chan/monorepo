/**
 * コードブロック / ファイル本文の行番号。チャット本文 (`CodeBlock`) とファイルプレビュー (`FilePreview`) が
 * 同じ見た目と数え方になるよう、番号の文字列と行数だけをここで決める (DOM に依存させない)。
 * 描画側は本文と同じ行送りの別列として置き、行番号の契約は docs/markdown.md を参照する。
 */

/**
 * 描画する本文の行数 (= 行番号の数)。番号は本文の行ボックスと 1 対 1 にするため、数え方をここに 1 つだけ置く。
 * 末尾の改行 1 つに空の行は描かれないので行に数えない。本文が空のときだけ 0 行 (空白だけでも行は描かれるので数える)。
 *
 * `caret` は生成中のカーソルを本文の後ろに出すかどうか。本文が空か改行で終わるときはカーソルが次の行に載るため、
 * その行の番号も出す。
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
