import { useCallback, useEffect, useState } from "react";
import { parseRoute, routePath, withoutEntrySpace, type Route } from "../lib/route";
import {
  DEFAULT_SETTINGS_SECTION,
  parseStoredSettingsSection,
  SETTINGS_SECTION_KEY,
  type SettingsSection,
} from "../lib/settingsNav";

/**
 * URL の pathname を画面の唯一の正として、`popstate` の購読と URL の置換を 1 箇所に集約する。
 * 画面切替の反映と URL の更新を必ず同じ `navigate` から行う (独立に同期させない)。
 * 切替は `replaceState` なので履歴は追加しない (Back / Forward はブラウザーの既存履歴に従う)。
 * クエリとフラグメントは解釈も破棄もしない (チャット本文の `#foo` 断片リンクを壊さないため持ち越す)。
 * 例外は `/s/<id>` の `space` だけで、初期 mount で読んだ後はキー単位で落とす (再読込では戻らない)。
 */
export type RouteState = {
  route: Route;
  navigate: (route: Route) => void;
  /**
   * URL を確定した選択へ合わせる。null は「書かない」で、置換は navigate と同じ `replaceState` に寄せる
   * (window.history を直接触る箇所を増やさない)。選択が変わっても URL を保つ間は null を渡す。
   */
  syncSessionPath: (path: string | null) => void;
  /** URL がセクションを明示していないとき (チャット) に「設定」で戻る先 */
  lastSettingsSection: SettingsSection;
};

export function useRoute(): RouteState {
  // 初期値は render 中に確定させる (URL 直開きで 1 フレーム分チャットが出るのを避ける)
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [lastSettingsSection, setLastSettingsSection] = useState<SettingsSection>(readStoredSettingsSection);

  // 起動時に URL が正準形でなければ置き換える (画面は上の初期値で既に正しい)
  useEffect(() => {
    const mounted = parseRoute(window.location.pathname);
    const canonical = routePath(mounted);
    // `/s/<id>` の `space` は SpacesApp が初期 mount で読んだ使い捨ての値なので、URL からは落とす
    const search = withoutEntrySpace(mounted, window.location.search);
    if (canonical !== window.location.pathname || search !== window.location.search) {
      replacePath(canonical, search);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // URL がセクションを明示している間は、それを「最後のセクション」として保存する (直リンクも含む)
  useEffect(() => {
    if (route.view !== "settings" || route.section === lastSettingsSection) return;
    setLastSettingsSection(route.section);
    writeStoredSettingsSection(route.section);
  }, [route, lastSettingsSection]);

  const navigate = useCallback((next: Route) => {
    replacePath(routePath(next));
    setRoute(next);
  }, []);

  const syncSessionPath = useCallback((path: string | null) => {
    if (path === null) return;
    replacePath(path);
    // 既に同じ path なら route の object を作り直さない (同じ値の set で描画を増やさない)
    setRoute((current) => (routePath(current) === path ? current : parseRoute(path)));
  }, []);

  return { route, navigate, syncSessionPath, lastSettingsSection };
}

/** pathname と search を差し替える。search を省くと現在の値を残す (フラグメントは常に残す) */
function replacePath(pathname: string, search = window.location.search): void {
  const { pathname: current, search: currentSearch, hash } = window.location;
  const url = `${pathname}${search}${hash}`;
  if (url === `${current}${currentSearch}${hash}`) return;
  window.history.replaceState(window.history.state, "", url);
}

function readStoredSettingsSection(): SettingsSection {
  try {
    return parseStoredSettingsSection(localStorage.getItem(SETTINGS_SECTION_KEY));
  } catch {
    // 保存領域が使えない環境では既定から始める (画面遷移は止めない)
    return DEFAULT_SETTINGS_SECTION;
  }
}

function writeStoredSettingsSection(section: SettingsSection): void {
  try {
    localStorage.setItem(SETTINGS_SECTION_KEY, section);
  } catch {
    // 同上。書けなくても URL が正なので遷移は成立する
  }
}
