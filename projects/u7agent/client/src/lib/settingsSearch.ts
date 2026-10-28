/**
 * 設定の一覧の絞り込み。**表示だけを絞る**ための純関数で、個別トグルと一括操作の母集合
 * (未絞込の visible 行) には使わない。検索中に隠れた行まで外すと、戻したときの状態が変わってしまう。
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 名前 / 説明などのどれかに含まれれば一致。空の検索語は常に一致する */
export function matchesQuery(query: string, fields: readonly (string | undefined)[]): boolean {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

/** 一覧の絞り込み。`fields` は行ごとの検索対象 (名前・説明など) */
export function filterBySearch<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => readonly (string | undefined)[],
): T[] {
  if (!normalizeQuery(query)) return [...rows];
  return rows.filter((row) => matchesQuery(query, fields(row)));
}
