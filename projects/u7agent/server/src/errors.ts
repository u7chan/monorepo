/**
 * サンドボックスからも参照するので HTTP の module とは分け、言語標準以外に依存しない。
 */
export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `statusCode` を持つ例外。任意にすると読む側が毎回 undefined を疑うため、この形だけを返す。
 * `instanceof` で分けると判定が増えるので、既存の `statusCodeOf()` の経路は変えない。
 */
export type HttpError = Error & { statusCode: number };

/** `statusCode` 付きの例外を作る。応答へ写す位置では statusCodeOf() で読むだけにする */
export function httpError(statusCode: number, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * サンドボックスのパス検証で使う例外。呼び出し側はこの名前で意図を読むため、`httpError` の別名を残す
 * (文言と statusCode の対応は呼び出し側が決める)。
 */
export function pathError(statusCode: number, message: string): HttpError {
  return httpError(statusCode, message);
}
