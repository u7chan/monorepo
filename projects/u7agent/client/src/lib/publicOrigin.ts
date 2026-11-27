/**
 * env で設定した公開オリジンを URL の基準へそろえる。値はサーバーが検証しているが、古い server や手で
 * 組んだ値でも壊れた URL を焼き込まないよう、ここでも http(s) の origin だけを通す。
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
