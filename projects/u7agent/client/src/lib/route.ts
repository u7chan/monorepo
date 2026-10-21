/**
 * URL の pathname と画面の対応。DOM も history も触らない純関数だけを置き、URL の読み書きは
 * hooks/useRoute.ts が担う。`/` はチャット (会話を指定しない)、`/settings/<section>` は設定の各画面
 * (SETTINGS_SECTIONS)、`/settings/<section>/<sub>` はタブを持つ画面 (MODELS_SUBSECTIONS /
 * CONTENT_SUBSECTIONS / FILES_SUBSECTIONS / RUNTIME_SUBSECTIONS)、`/s/<sessionId>` はチャット + URL が指定する会話。
 * 未知・不正なパスはチャットへ畳み、routePath は常に正準形 (小文字・末尾スラッシュなし・既定タブの
 * パスなし) を返す。
 * `/s/<sessionId>` の `space` クエリだけは会話を指定した URL の入力として解釈し (entrySpaceOf)、
 * 確定した選択の URL には所属スペースを載せ直す (withEntrySpace)。
 */
import {
  CONTENT_SUBSECTIONS,
  DEFAULT_CONTENT_SUBSECTION,
  DEFAULT_FILES_SUBSECTION,
  DEFAULT_MODELS_SUBSECTION,
  DEFAULT_RUNTIME_SUBSECTION,
  FILES_SUBSECTIONS,
  MODELS_SUBSECTIONS,
  RUNTIME_SUBSECTIONS,
  SETTINGS_SECTIONS,
  type ContentSubsection,
  type FilesSubsection,
  type ModelsSubsection,
  type RuntimeSubsection,
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
      /** 設定 → コンテンツ生成のタブ。同じく既定タブ (画像生成) は省略する */
      contentSubsection?: ContentSubsection;
      /** 設定 → ファイルのタブ。既定タブは省略し、パスにも出さない */
      filesSubsection?: FilesSubsection;
      /** 設定 → ランタイムのタブ。同じく既定タブは省略する */
      runtimeSubsection?: RuntimeSubsection;
    };

/** 会話を指定しないチャット (正準形の `/`)。未知・解釈不能なパスを畳む先でもある */
export const CHAT_ROUTE: Route = { view: "chat" };

/**
 * pathname から画面を決める。クエリとフラグメントは pathname に含めない契約
 * (含めると `#foo` 付きのリンクが画面として解釈できなくなる) ため、境界側で切り落とす。
 * タブを持つ画面 (models / content / files / runtime) だけは `/settings/<section>/<sub>` の 1 セグメントを解釈し、
 * 未知のサブセクションと既定タブの明示 (`/settings/models/models` 等) は既定タブへ正準化する。
 * 旧 設定 → ダウンロード (`/settings/archive`) は 設定 → ファイル の「ダウンロードの除外」タブへ読み替える。
 */
export function parseRoute(pathname: string): Route {
  const decoded = decodePathname(pathname);
  if (decoded === null) return CHAT_ROUTE;
  const [head, second, third, ...rest] = decoded.split("/").filter((segment) => segment !== "");
  const kind = head?.toLowerCase();
  if (kind === "settings") {
    // 旧 設定 → ダウンロード。"archive" はセクションとしては削除したので、先に読み替える
    if (second?.toLowerCase() === "archive") {
      return third === undefined ? { view: "settings", section: "files", filesSubsection: "archive" } : CHAT_ROUTE;
    }
    const found = SETTINGS_SECTIONS.find((item) => item.section === second?.toLowerCase());
    if (!found) return CHAT_ROUTE;
    if (found.section === "files") {
      if (rest.length > 0) return CHAT_ROUTE;
      const subsection = FILES_SUBSECTIONS.find((item) => item.subsection === third?.toLowerCase())?.subsection;
      return subsection && subsection !== DEFAULT_FILES_SUBSECTION
        ? { view: "settings", section: "files", filesSubsection: subsection }
        : { view: "settings", section: "files" };
    }
    if (found.section === "content") {
      if (rest.length > 0) return CHAT_ROUTE;
      const subsection = CONTENT_SUBSECTIONS.find((item) => item.subsection === third?.toLowerCase())?.subsection;
      return subsection && subsection !== DEFAULT_CONTENT_SUBSECTION
        ? { view: "settings", section: "content", contentSubsection: subsection }
        : { view: "settings", section: "content" };
    }
    if (found.section === "runtime") {
      if (rest.length > 0) return CHAT_ROUTE;
      const subsection = RUNTIME_SUBSECTIONS.find((item) => item.subsection === third?.toLowerCase())?.subsection;
      return subsection && subsection !== DEFAULT_RUNTIME_SUBSECTION
        ? { view: "settings", section: "runtime", runtimeSubsection: subsection }
        : { view: "settings", section: "runtime" };
    }
    if (found.section !== "models")
      return third === undefined ? { view: "settings", section: found.section } : CHAT_ROUTE;
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
    if (
      route.section === "content" &&
      route.contentSubsection &&
      route.contentSubsection !== DEFAULT_CONTENT_SUBSECTION
    ) {
      return `/settings/content/${route.contentSubsection}`;
    }
    if (route.section === "files" && route.filesSubsection && route.filesSubsection !== DEFAULT_FILES_SUBSECTION) {
      return `/settings/files/${route.filesSubsection}`;
    }
    if (route.section === "models" && route.modelsSubsection && route.modelsSubsection !== DEFAULT_MODELS_SUBSECTION) {
      return `/settings/models/${route.modelsSubsection}`;
    }
    if (
      route.section === "runtime" &&
      route.runtimeSubsection &&
      route.runtimeSubsection !== DEFAULT_RUNTIME_SUBSECTION
    ) {
      return `/settings/runtime/${route.runtimeSubsection}`;
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
 * 同じ URL でも返す (所属スペースを載せ直すため)。同一 URL の置換は書き手 (useRoute) が省く。
 */
export function sessionPath(view: Route["view"], selectedSessionId: string, entryResolved: boolean): string | null {
  if (view !== "chat") return null;
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
 * 会話を指定した URL の `space` を `spaceId` に揃えた search。他の画面の URL からは外す (残っていても
 * 解決には使わない)。他のクエリは順序も書き方もそのまま残すため、`URLSearchParams` で組み直さず、
 * 項単位で入れ替える。
 */
export function withEntrySpace(route: Route, search: string, spaceId: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const kept = query ? query.split("&").filter((part) => !isSpaceParameter(part)) : [];
  if (!sessionIdOf(route)) return kept.length > 0 ? `?${kept.join("&")}` : "";
  return `?${[`${SPACE_QUERY_KEY}=${encodeURIComponent(spaceId)}`, ...kept].join("&")}`;
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
