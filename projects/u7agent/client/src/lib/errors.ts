/**
 * 例外から画面に出す 1 行。Error 以外が投げられても文を空にしない。
 * settingsResource.ts に置くと、これだけを使う module が設定資源の文言まで読み込むため分ける。
 */
export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
