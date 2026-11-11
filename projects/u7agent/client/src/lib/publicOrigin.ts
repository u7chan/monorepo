/**
 * env で設定した公開オリジン (health の appOrigin / filePreviewOrigin / serviceOrigin) を URL の基準へ
 * そろえる。値はサーバーが起動時に検証しているが、古い server や手で組んだ値でも壊れた URL を
 * 画面へ焼き込まないよう、ここでも http(s) の origin だけを通す。通らなければ呼び出し側の
 * フォールバック (現行の hostname + port) に任せる。
 */
export function publicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  return url.origin;
}
