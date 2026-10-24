/**
 * コンテンツ生成の有効 / 無効。画像・音声・BGM の 3 ツールは同じ 1 つのトグルを見るため、
 * ツール定義のモジュールではなくここに文言と実行時の判定を置く（docs/image-generation.md）。
 * 設定 API も `disabledMessage` として同じ文言を返し、画面とモデルへ返る文が食い違わないようにする。
 */
export const CONTENT_DISABLED_MESSAGE =
  "コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。";

/**
 * 実行時の課金前チェックで止めるべきか。**設定のトグルが OFF のときだけ true** にする。
 * キーの行が無い（未設定・削除後）は false にして `readSettings()` のキー無効エラーへ落とす:
 * ここで止めると「無効化されています」と案内し、キーの再登録を促せなくなる。
 */
export function contentGenerationDisabled(config: { disabled: boolean } | undefined): boolean {
  return config?.disabled === true;
}
