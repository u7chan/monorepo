/**
 * SQLite の行から値を読む共通ヘルパ。`app-db.ts` と ドメイン別のリポジトリ
 * (`shared-content-repository.ts`) が同じ読み方をするためにここへ置く。
 */
export type Row = Record<string, unknown>;

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** NULL を不明のまま読む (移行前の行を 0 と混同しない) */
export function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** 自分で書いた JSON 列だけを読む。壊れていたら黙って空にせず例外にして 503 側で見せる */
export function jsonArray<T>(value: unknown): T[] | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

export function jsonObject<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
}

/**
 * 保存行の JSON 配列を読む。JSON.parse の文言は値の断片を写すため、テーブル / 列だけを示して
 * 503 へ渡す (health とログで、どの行を直せばよいか分かるようにする)。
 */
export function jsonArrayColumn<T>(table: string, column: string, value: unknown): T[] | undefined {
  try {
    return jsonArray<T>(value);
  } catch {
    throw new Error(`${table}.${column} is not valid JSON`);
  }
}

/** BLOB 列は Uint8Array。手編集で TEXT にされた行は「保存値が欠けている」として null で読む */
export function optionalBlob(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}
