/**
 * 人とモデルへ見せる日時は JST 固定にする。実行環境の TZ（コンテナは既定で UTC）に依存させると、
 * UTC で動く BFF が書いたメモやツール出力が UTC のまま届く (設定化は非ゴール、docs/web-search.md#非ゴール)。
 */
export const JST_TIME_ZONE = "Asia/Tokyo";

// Intl.DateTimeFormat の生成は重い。呼び出しごとに作らないよう 1 つだけ持つ。
// locale を en-US に固定し、実行環境の LANG / ICU の既定書式には依存しない。
const jstFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: JST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // hour12: false だけでは深夜が 24 時になる実装があるため、時刻周期を明示する
  hourCycle: "h23",
});

function jstParts(at: number): Record<string, string> {
  const values: Record<string, string> = {};
  for (const part of jstFormatter.formatToParts(at)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return values;
}

/** JST の YYYY-MM-DD */
export function formatJstDate(at: number): string {
  const value = jstParts(at);
  return `${value.year}-${value.month}-${value.day}`;
}

/** JST の YYYY-MM-DD HH:mm:ss */
export function formatJstDateTime(at: number): string {
  const value = jstParts(at);
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}
