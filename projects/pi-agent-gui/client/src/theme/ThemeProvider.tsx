import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_THEME,
  SYSTEM_DARK_ID,
  SYSTEM_LIGHT_ID,
  THEME_STORAGE_KEY,
  THEMES,
  parseStoredThemeChoice,
  type ThemeChoice,
  type ThemeId,
} from "./themes";

export type ThemeContextValue = {
  /** ユーザーの選択。"system" なら OS 設定に追従する */
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  /** choice を解決した実際のテーマ id (html の data-theme に反映する) */
  resolvedId: ThemeId;
  themes: typeof THEMES;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getLightModeQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  try {
    return window.matchMedia("(prefers-color-scheme: light)");
  } catch {
    return null;
  }
}

function readStoredChoice(): ThemeChoice {
  try {
    return parseStoredThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function subscribeLightMode(onChange: () => void) {
  const query = getLightModeQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

const lightModeSnapshot = () => getLightModeQuery()?.matches ?? false;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const prefersLight = useSyncExternalStore(subscribeLightMode, lightModeSnapshot, () => false);

  const resolvedId: ThemeId =
    choice === "system" ? (prefersLight ? SYSTEM_LIGHT_ID : SYSTEM_DARK_ID) : choice;

  // theme-init.js と同じ契約: html の data-theme を同期する (初回描画前の FOUC 防止は theme-init.js 側)
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedId;
  }, [resolvedId]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage が使えない環境では状態の反映だけ行う
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ choice, setChoice, resolvedId, themes: THEMES }),
    [choice, setChoice, resolvedId],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
