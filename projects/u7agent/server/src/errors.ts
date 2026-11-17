/**
 * 例外からログ・応答に出す 1 行。サンドボックスからも参照するので HTTP の module とは分ける。
 * 依存は言語標準だけに留める (hono / zod / node:* を引くとサンドボックスの起動が BFF 側へ縛られる)。
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
