/**
 * コンテンツ生成の有効 / 無効。画像・音声・BGM の 3 ツールは同じ 1 つのトグルを見るため、
 * ツール定義のモジュールではなくここに文言を置く（docs/image-generation.md）。設定 API も
 * `disabledMessage` として同じ文言を返し、画面とモデルへ返る文が食い違わないようにする。
 */
export const CONTENT_DISABLED_MESSAGE =
  "コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。";
