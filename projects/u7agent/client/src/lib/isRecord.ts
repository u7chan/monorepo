/** 配列を除く object。保存値の decode は、配列を record として読まないためにこれを通す */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
