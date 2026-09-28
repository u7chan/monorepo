/**
 * URL の pathname と画面の対応。DOM も history も触らない純関数だけを置き、URL の読み書きは
 * hooks/useRoute.ts が担う。`/` はチャット、`/settings/<section>` は設定の各画面 (SETTINGS_SECTIONS)、
 * `/settings/models/<sub>` はモデル画面のタブ (MODELS_SUBSECTIONS)、`/s/<sessionId>` は通知の
 * ディープリンク (チャット + 選択待ちの入口)。未知・不正なパスはチャットへ畳み、routePath は常に
 * 正準形 (小文字・末尾スラッシュなし・既定タブのパスなし) を返す。
 */
import {
  DEFAULT_MODELS_SUBSECTION,
  MODELS_SUBSECTIONS,
  SETTINGS_SECTIONS,
  type ModelsSubsection,
  type SettingsSection,
} from "./settingsNav";

export type Route =
  | {
      view: "chat";
      /** `/s/<id>` の保留中の入口。選択が確定したら foldPendingEntry で畳む (それまで URL を保つ) */
      pendingSessionId?: string;
    }
  | {
      view: "settings";
      section: SettingsSection;
      /** 設定 → モデルのタブ。既定タブは省略し、パスにも出さない */
      modelsSubsection?: ModelsSubsection;
    };

/** 未知のパスを畳む先。同じ object を返すので、呼び出し側は参照で比較できる */
export const CHAT_ROUTE: Route = { view: "chat" };

/**
 * pathname から画面を決める。クエリとフラグメントは pathname に含めない契約
 * (含めると `#foo` 付きのリンクが画面として解釈できなくなる) ため、境界側で切り落とす。
 * モデル画面だけは `/settings/models/<sub>` の 1 セグメントをタブとして解釈し、未知の
 * サブセクションと `/settings/models/models` (既定タブ) は既定タブへ正準化する。
 */
export function parseRoute(pathname: string): Route {
  const decoded = decodePathname(pathname);
  if (decoded === null) return CHAT_ROUTE;
  const [head, second, third, ...rest] = decoded.split("/").filter((segment) => segment !== "");
  const kind = head?.toLowerCase();
  if (kind === "settings") {
    const found = SETTINGS_SECTIONS.find((item) => item.section === second?.toLowerCase());
    if (!found) return CHAT_ROUTE;
    if (found.section !== "models")
      return third === undefined ? { view: "settings", section: found.section } : CHAT_ROUTE;
    // モデルはサブセクション 1 段だけを解釈する。深いパスは他の画面と同じくチャットへ畳む
    if (rest.length > 0) return CHAT_ROUTE;
    const subsection = MODELS_SUBSECTIONS.find((item) => item.subsection === third?.toLowerCase())?.subsection;
    return subsection && subsection !== DEFAULT_MODELS_SUBSECTION
      ? { view: "settings", section: "models", modelsSubsection: subsection }
      : { view: "settings", section: "models" };
  }
  // id は不透明な値なので、decode 済みのものをそのまま持ち URL へ戻すときだけ encode する
  return kind === "s" && second && third === undefined ? { view: "chat", pendingSessionId: second } : CHAT_ROUTE;
}

/** 画面から pathname を作る。URL の分解は呼び出し側が行い、ここではクエリもフラグメントも付けない */
export function routePath(route: Route): string {
  if (route.view === "settings") {
    if (route.section === "models" && route.modelsSubsection && route.modelsSubsection !== DEFAULT_MODELS_SUBSECTION) {
      return `/settings/models/${route.modelsSubsection}`;
    }
    return `/settings/${route.section}`;
  }
  return route.pendingSessionId ? `/s/${encodeURIComponent(route.pendingSessionId)}` : "/";
}

/** 選択待ちの入口 (`/s/<id>`) の sessionId。チャット以外の画面は持たない */
export function pendingSessionIdOf(route: Route): string | undefined {
  return route.view === "chat" ? route.pendingSessionId : undefined;
}

/** 入口を畳んだ route。入口が無ければ同じ object を返すので、呼び出し側は参照で「畳むか」を判定できる */
export function foldPendingEntry(route: Route): Route {
  return pendingSessionIdOf(route) ? CHAT_ROUTE : route;
}

/** 不正な percent encoding は例外にせず、解釈不能として畳む先 (チャット) を選ばせる */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
