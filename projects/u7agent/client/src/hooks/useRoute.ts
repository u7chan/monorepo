import { useCallback, useEffect, useRef, useState } from "react";
import { foldPendingEntry, parseRoute, routePath, type Route } from "../lib/route";
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
 */
export type RouteState = {
  route: Route;
  navigate: (route: Route) => void;
  /** 選択待ちの入口 (`/s/<id>`) を消費して `/` へ畳む。選択が確定してから呼ぶ (履歴は増やさない) */
  consumePendingEntry: () => void;
  /** URL がセクションを明示していないとき (チャット) に「設定」で戻る先 */
  lastSettingsSection: SettingsSection;
};

export function useRoute(): RouteState {
  // 初期値は render 中に確定させる (URL 直開きで 1 フレーム分チャットが出るのを避ける)
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [lastSettingsSection, setLastSettingsSection] = useState<SettingsSection>(readStoredSettingsSection);

  // 選択待ちの入口は URL を保ったまま待つ (ここで畳むと、選択が確定する前にリンクが消える)
  const routeRef = useRef(route);
  routeRef.current = route;

  // 起動時に URL が正準形でなければ置き換える (画面は上の初期値で既に正しい)
  useEffect(() => {
    const canonical = routePath(parseRoute(window.location.pathname));
    if (canonical !== window.location.pathname) replacePath(canonical);
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

  const consumePendingEntry = useCallback(() => {
    const next = foldPendingEntry(routeRef.current);
    // 既に別の画面へ移っていたら、その画面と URL の対応を壊さない
    if (next === routeRef.current) return;
    replacePath(routePath(next));
    setRoute(next);
  }, []);

  return { route, navigate, consumePendingEntry, lastSettingsSection };
}

/** pathname だけを差し替える。クエリとフラグメントは現在の URL のものを残す */
function replacePath(pathname: string): void {
  const { pathname: current, search, hash } = window.location;
  const url = `${pathname}${search}${hash}`;
  if (url === `${current}${search}${hash}`) return;
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
