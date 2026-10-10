/**
 * URL の pathname と画面の対応。DOM も history も触らない純関数だけを置き、URL の読み書きは
 * hooks/useRoute.ts が担う。`/` はチャット (会話を指定しない)、`/settings/<section>` は設定の各画面
 * (SETTINGS_SECTIONS)、`/settings/models/<sub>` はモデル画面のタブ (MODELS_SUBSECTIONS)、
 * `/s/<sessionId>` はチャット + URL が指定する会話。未知・不正なパスはチャットへ畳み、routePath は
 * 常に正準形 (小文字・末尾スラッシュなし・既定タブのパスなし) を返す。
 * `/s/<sessionId>` の `space` クエリだけは会話を指定した URL の入力として解釈し (entrySpaceOf)、
 * 読んだ後はキー単位で落とす (withoutEntrySpace)。
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
      /**
       * `/s/<id>` が指定する会話。確定した選択を映す鏡で、表示の正ではない (同期は sessionPath が決め、
       * 書くのは App の Effect)。未指定の `/` は会話を指定しない
       */
      sessionId?: string;
    }
  | {
      view: "settings";
      section: SettingsSection;
      /** 設定 → モデルのタブ。既定タブは省略し、パスにも出さない */
      modelsSubsection?: ModelsSubsection;
    };

/** 会話を指定しないチャット (正準形の `/`)。未知・解釈不能なパスを畳む先でもある */
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
  return kind === "s" && second && third === undefined ? { view: "chat", sessionId: second } : CHAT_ROUTE;
}

/** 画面から pathname を作る。URL の分解は呼び出し側が行い、ここではクエリもフラグメントも付けない */
export function routePath(route: Route): string {
  if (route.view === "settings") {
    if (route.section === "models" && route.modelsSubsection && route.modelsSubsection !== DEFAULT_MODELS_SUBSECTION) {
      return `/settings/models/${route.modelsSubsection}`;
    }
    return `/settings/${route.section}`;
  }
  return route.sessionId ? `/s/${encodeURIComponent(route.sessionId)}` : "/";
}

/** URL が指定する会話の sessionId。チャット以外の画面は持たない */
export function sessionIdOf(route: Route): string | undefined {
  return route.view === "chat" ? route.sessionId : undefined;
}

/**
 * 確定した選択を映すチャットの pathname。書く必要が無ければ null を返す (呼び出し側は何もしない)。
 * 画面は URL のセクションが正なので設定の表示中は書かない。未解決の入口が未選択のままの間も書かない
 * (URL を保ち、次に届いた一覧で解決する)。未解決でも選択が確定していればその選択を書く。
 * `undefined` (会話 ID なし) と `""` (選択なし) は同じ「会話なし」として扱い、未選択を `/s/` と書かない。
 */
export function sessionPath(
  view: Route["view"],
  urlSessionId: string | undefined,
  selectedSessionId: string,
  entryResolved: boolean,
): string | null {
  if (view !== "chat") return null;
  const current = urlSessionId ?? "";
  // 既に一致している (会話なし同士も含む) ときは同じ URL を書き直さない
  if (current === selectedSessionId) return null;
  if (!entryResolved && selectedSessionId === "") return null;
  return routePath(selectedSessionId ? { view: "chat", sessionId: selectedSessionId } : CHAT_ROUTE);
}

/**
 * 入口の解決状態の初期値。URL が会話を指定していなければ保つ URL が無いので、最初から解決済みとする。
 * mount 時に 1 度だけ読み、同期 Effect が URL を書いて prop が変わっても巻き戻さない。
 */
export function entryResolvedInitially(sessionId: string | undefined): boolean {
  return !sessionId;
}

/** 会話を指定した URL が載せる、開くスペースのクエリ名 */
const SPACE_QUERY_KEY = "space";

/**
 * 会話を指定した URL (`/s/<id>`) だけが読む `space` クエリ。他の画面では pathname と同じく解釈しない
 * (他のクエリ・フラグメントを画面判断へ持ち込まない契約を崩さないため)。値が空なら無いものとして扱う。
 */
export function entrySpaceOf(route: Route, search: string): string | null {
  if (!sessionIdOf(route)) return null;
  const value = new URLSearchParams(search).get(SPACE_QUERY_KEY);
  return value ? value : null;
}

/**
 * 会話を指定した URL の `space` キーだけを落とした search。読んだ値は使い捨てで、URL には残さない
 * (Back / Forward で戻っても選択を切り替えない)。他のクエリは順序も書き方もそのまま残すため、
 * `URLSearchParams` で組み直さず、項単位で外す。
 */
export function withoutEntrySpace(route: Route, search: string): string {
  if (!sessionIdOf(route)) return search;
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
 * 会話を指定して開くリンク。`space` を載せると初期 mount がそのスペースを選ぶので、
 * 保存値が別のスペースでも会話の所属で開ける (不明なら付けず、保存値で解決する現行どおり)。
 */
export function sessionEntryHref(sessionId: string, spaceId?: string): string {
  const path = routePath({ view: "chat", sessionId });
  return spaceId === undefined ? path : `${path}?${SPACE_QUERY_KEY}=${encodeURIComponent(spaceId)}`;
}

/** 不正な percent encoding は例外にせず、解釈不能として畳む先 (チャット) を選ばせる */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
