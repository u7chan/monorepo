/**
 * コードブロック / ファイル本文の行番号。チャット本文 (`CodeBlock`) とファイルプレビュー (`FilePreview`) が
 * 同じ見た目と数え方になるよう、番号の文字列と行数だけをここで決める (DOM に依存させない)。
 * 描画側は本文と同じ行送りの別列として置き、行番号の契約は docs/markdown.md を参照する。
 */

/**
 * 描画する本文の行数。番号は本文の行と 1 対 1 にするため、行の数え方をここに 1 つだけ置く。
 * 末尾の改行 1 つに空の行は描かれないので行に数えない。空白だけの本文は 0 行 (空のブロック)。
 */
export function codeLineCount(text: string): number {
  if (text.trim() === "") return 0;
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
