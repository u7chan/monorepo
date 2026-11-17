/**
 * 例外からログ・応答に出す 1 行。サンドボックスからも参照するので HTTP の module とは分ける。
 * 依存は言語標準だけに留める (hono / zod / node:* を引くとサンドボックスの起動が BFF 側へ縛られる)。
 */
export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
