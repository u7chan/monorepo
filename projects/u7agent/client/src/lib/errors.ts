/**
 * 例外から画面に出す 1 行。Error 以外が投げられても文を空にしない。
 * settingsResource.ts に置くと、これだけを使う module が設定資源の文言まで読み込むため分ける。
 */
export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * HTTP の応答として返った失敗の status。接続自体の失敗と区別するために使う。`ApiError` を import
 * しないのは、`api/http.ts` が `location` を参照し DOM の無いテストから読めないため。
 */
export function apiFailureStatus(error: unknown): number | undefined {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}
