/**
 * 作業環境 → 環境変数タブの変数の値の表示。計測値と文字列だけを受け取る純関数に閉じ、
 * 「2 行に収まるか」「開閉の文言」「折り返しの候補」を決める。値の取得は EnvVarsTab が持つ。
 */

/** 未取得の値の代わりに出す 1 文字。取得でき次第、行の箱へ差し込む */
export const ENV_VALUE_PENDING = "…";

export const ENV_VALUE_EXPAND_LABEL = "すべて表示";

export const ENV_VALUE_COLLAPSE_LABEL = "たたむ";

/** 値だけ取れなかった行の注記。行単位の再試行が無いため、タブの再読み込みへ案内する */
export const ENV_VALUE_ERROR_NOTE = "値を読み込めませんでした（「再読み込み」で取り直せます）";

export function envValueToggleLabel(expanded: boolean): string {
  return expanded ? ENV_VALUE_COLLAPSE_LABEL : ENV_VALUE_EXPAND_LABEL;
}

/**
 * 値の `<code>` が 2 行の clamp を超えているか。clamp 中でも scrollHeight は全文の高さを返す前提で、
 * clientHeight との差だけを見る (+1 は端数の丸めの許容で、既存の measureUserMessageClamp と揃える)。
 */
export function envValueOverflows({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return scrollHeight > clientHeight + 1;
}

/** `<wbr>` を入れる区切りの直後。URL / DSN を語の途中ではなく区切りで折る */
const BREAK_AFTER = /[/?&@]/u;

/**
 * 表示用の分割。区切りの直後に `<wbr>` を入れるため、区切りを含む断片の一覧として返す
 * (join すると原文に戻る)。コピーは原文を渡すので、この分割は表示にだけ効く。
 */
export function envValueSegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!BREAK_AFTER.test(value[index])) continue;
    segments.push(value.slice(start, index + 1));
    start = index + 1;
  }
  if (start < value.length) segments.push(value.slice(start));
  return segments;
}
