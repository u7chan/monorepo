// イメージタグの作成日表示。GHCR の version は UTC で返るが、portal の利用者は
// JST で運用しているため、日付境界も JST に揃える。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * ISO 8601 の日時を JST の YYYY-MM-DD にする。
 * 実行環境のタイムゾーンやロケールに依存させないため、固定オフセットで計算する。
 */
export function formatTagDate(createdAt: string | undefined): string | undefined {
  if (!createdAt) {
    return undefined;
  }

  const time = Date.parse(createdAt);
  if (Number.isNaN(time)) {
    return undefined;
  }

  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}
