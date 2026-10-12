/**
 * ツール結果本文の先頭行から値を読む共通処理。表示用の投影は先頭 900 文字で切る
 * （`server/src/session-projection.ts` の `SUMMARY_TEXT_MAX`）ため、本文全体を走査しても
 * 見つかる行は増えない（無関係な行を拾う危険だけが増える）。
 */

/** 投影で値が欠け得る最終行を除いたうえで見る行数 */
const HEAD_LINE_COUNT = 3;

/**
 * 改行で終わる行だけを読む。投影で切られた最終行は値が欠けている可能性がある（例: 保存パスの断片）。
 */
export function headValue(output: string, label: string): string | undefined {
  const lines = output.split("\n");
  for (const line of lines.slice(0, Math.min(lines.length - 1, HEAD_LINE_COUNT))) {
    if (!line.startsWith(label)) continue;
    const value = line.slice(label.length).trim();
    if (value !== "") return value;
  }
  return undefined;
}
