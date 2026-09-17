/**
 * URL の pathname と画面の対応。DOM も history も触らない純関数だけを置き、URL の読み書きは
 * hooks/useRoute.ts が担う。`/` はチャット、`/settings/<section>` は設定の 5 画面。
 * 未知・不正なパスはチャットへ畳み、routePath は常に正準形 (小文字・末尾スラッシュなし) を返す。
 */
import { SETTINGS_SECTIONS, type SettingsSection } from "./settingsNav";

export type Route = { view: "chat" } | { view: "settings"; section: SettingsSection };

/** 未知のパスを畳む先。同じ object を返すので、呼び出し側は参照で比較できる */
export const CHAT_ROUTE: Route = { view: "chat" };

/**
 * pathname から画面を決める。クエリとフラグメントは pathname に含めない契約
 * (含めると `#foo` 付きのリンクが画面として解釈できなくなる) ため、境界側で切り落とす。
 */
export function parseRoute(pathname: string): Route {
  const decoded = decodePathname(pathname);
  if (decoded === null) return CHAT_ROUTE;
  const [head, section, ...rest] = decoded.split("/").filter((segment) => segment !== "");
  if (rest.length > 0 || head?.toLowerCase() !== "settings") return CHAT_ROUTE;
  const found = SETTINGS_SECTIONS.find((item) => item.section === section?.toLowerCase());
  return found ? { view: "settings", section: found.section } : CHAT_ROUTE;
}

/** 画面から pathname を作る。URL の分解は呼び出し側が行い、ここではクエリもフラグメントも付けない */
export function routePath(route: Route): string {
  return route.view === "settings" ? `/settings/${route.section}` : "/";
}

/** 不正な percent encoding は例外にせず、解釈不能として畳む先 (チャット) を選ばせる */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
