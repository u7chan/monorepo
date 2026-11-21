// useTheme - 外観の設定を保持し、<html data-theme> と theme-color の meta へ反映する

import { useCallback, useEffect, useState } from "react";
import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  themeColorFor,
  type ThemePreference,
  type ThemeScheme,
} from "../lib/theme";

function readPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // プライベートブラウズなどで storage に触れない環境では、設定を持たない扱いにする
    return "system";
  }
}

function persistPreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // 保存できなくても、このタブの中では切り替えられる
  }
}

function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;

  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme: ThemeScheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = themeColorFor(preference, scheme);
  }
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);

  // data-theme は index.html の描画前スクリプトが付けるので、ここでは meta だけを合わせる。
  // 以降の変更は setPreference が反映するため、依存に state を持たせず保存値を読み直す。
  useEffect(() => {
    applyPreference(readPreference());
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    // state は View Transition の外で同期的に更新する。コールバックの中で更新すると、
    // 制御された radio が次のフレームまで元の選択へ戻って見える。
    setPreferenceState(next);
    persistPreference(next);

    // 動きを減らす設定では View Transition を使わず、その場で切り替える
    if (
      typeof document.startViewTransition === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      document.startViewTransition(() => applyPreference(next));
      return;
    }

    applyPreference(next);
  }, []);

  return { preference, setPreference };
}

export default useTheme;
