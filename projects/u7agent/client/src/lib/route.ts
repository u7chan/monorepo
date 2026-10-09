/**
 * URL の pathname と画面の対応。DOM も history も触らない純関数だけを置き、URL の読み書きは
 * hooks/useRoute.ts が担う。`/` はチャット、`/settings/<section>` は設定の各画面 (SETTINGS_SECTIONS)、
 * `/settings/models/<sub>` はモデル画面のタブ (MODELS_SUBSECTIONS)、`/s/<sessionId>` は通知の
 * ディープリンク (チャット + 選択待ちの入口)。未知・不正なパスはチャットへ畳み、routePath は常に
 * 正準形 (小文字・末尾スラッシュなし・既定タブのパスなし) を返す。
 * `/s/<sessionId>` の `space` クエリだけは入口の入力として解釈し (entrySpaceOf)、読んだ後は
 * キー単位で落とす (withoutEntrySpace)。
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

/** 入口のリンクが載せる、開くスペースのクエリ名 */
const SPACE_QUERY_KEY = "space";

/**
 * 入口 (`/s/<id>`) だけが読む `space` クエリ。他の画面では pathname と同じく解釈しない
 * (他のクエリ・フラグメントを画面判断へ持ち込まない契約を崩さないため)。値が空なら無いものとして扱う。
 */
export function entrySpaceOf(route: Route, search: string): string | null {
  if (!pendingSessionIdOf(route)) return null;
  const value = new URLSearchParams(search).get(SPACE_QUERY_KEY);
  return value ? value : null;
}

/**
 * 入口の `space` キーだけを落とした search。読んだ値は使い捨てで、URL には残さない
 * (Back / Forward で戻っても選択を切り替えない)。他のクエリは順序も書き方もそのまま残すため、
 * `URLSearchParams` で組み直さず、項単位で外す。
 */
export function withoutEntrySpace(route: Route, search: string): string {
  if (!pendingSessionIdOf(route)) return search;
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return "";
  const kept = query.split("&").filter((part) => !isSpaceParameter(part));
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

function isSpaceParameter(part: string): boolean {
  const [rawKey = ""] = part.split("=", 1);
  try {
    return decodeURIComponent(rawKey) === SPACE_QUERY_KEY;
  } catch {
    // 解釈できないキーは落とさない (他のクエリを壊すより残す)
    return false;
  }
}

/**
 * 会話を指定して開くリンク。`space` を載せると入口の初期 mount がそのスペースを選ぶので、
 * 保存値が別のスペースでも会話の所属で開ける (不明なら付けず、保存値で解決する現行どおり)。
 */
export function sessionEntryHref(sessionId: string, spaceId?: string): string {
  const path = routePath({ view: "chat", pendingSessionId: sessionId });
  return spaceId === undefined ? path : `${path}?${SPACE_QUERY_KEY}=${encodeURIComponent(spaceId)}`;
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
