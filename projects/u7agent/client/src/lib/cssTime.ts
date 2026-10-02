/**
 * CSS の時間値から最大値を ms で返す。`animation-duration` / `transition-duration` の computed 値は
 * カンマ区切りのリストを取り得る (`animation-name` の数だけ値が並ぶ) ため、先頭だけを読むと後ろにある
 * 長い値を取りこぼす (その長さで動いているアニメーションより短い保険タイマーが先に走ってしまう)。
 */
export function maxDurationMs(value: string): number {
  let max = 0;
  for (const part of value.split(",")) {
    const text = part.trim();
    const number = Number.parseFloat(text);
    if (!Number.isFinite(number)) continue;
    // 単位は接尾辞で見る。`ms` を先に見ないと `200ms` が 200 秒になる (CSS では単位なしの値は不正なので無視する)
    if (text.endsWith("ms")) max = Math.max(max, number);
    else if (text.endsWith("s")) max = Math.max(max, number * 1000);
  }
  return max;
}
