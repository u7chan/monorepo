import { cn } from "../../lib/cn";
import { useTheme } from "../../theme/ThemeProvider";
import { CheckIcon } from "../icons";
import { ThemePreview } from "./ThemePreview";

const APPEARANCE_LABEL = { dark: "ダーク", light: "ライト" } as const;

/** 一覧の見出しと並び。テーマ registry の並び (ダーク → ライト) をそのまま 2 群に割る */
const GROUPS = [
  { appearance: "dark", label: "ダーク" },
  { appearance: "light", label: "ライト" },
] as const;

/**
 * テーマの一覧。各テーマを実配色のプレビュー付きで並べ、押すと ThemeProvider の選択を
 * 切り替える（適用と保存は ThemeSwitcher と同じ経路なので、両者の表示は必ず一致する）。
 */
export function ThemeGallery() {
  const { choice, setChoice, themes } = useTheme();

  return (
    <div className="grid gap-3">
      {GROUPS.map((group) => (
        <section key={group.appearance} className="grid gap-2">
          <h3 className="text-3xs font-semibold tracking-label text-ink-faint uppercase">{group.label}</h3>
          <div className="grid gap-2 wide:grid-cols-2">
            {themes
              .filter((theme) => theme.appearance === group.appearance)
              .map((theme) => {
                const selected = choice === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setChoice(theme.id)}
                    className={cn(
                      "grid gap-2 rounded-lg border bg-panel p-2 text-left transition-colors",
                      selected ? "border-focus" : "border-line hover:border-accent/50",
                    )}
                  >
                    <ThemePreview themeId={theme.id} />
                    <span className="flex items-center gap-1.5 px-0.5">
                      <span className={cn("text-xs font-semibold", selected ? "text-accent-text" : "text-ink")}>
                        {theme.label}
                      </span>
                      <span className="text-2xs text-ink-ghost">{APPEARANCE_LABEL[theme.appearance]}</span>
                      {selected ? (
                        <span className="ml-auto text-accent-text">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
