import type { ChangeEvent } from "react";
import { useTheme } from "./ThemeProvider";
import { isThemeId, type ThemeChoice } from "./themes";

export type ThemeSwitcherProps = {
  /** レイアウト調整用のクラスを外部から差し込む */
  className?: string;
  /** ドロワーなど compact な領域向け。iOS の focus 時ズームを避けるため 16px 以上にする */
  compact?: boolean;
};

/** トップバー右上に置く想定のコンパクトなテーマ選択 */
export function ThemeSwitcher({ className, compact = false }: ThemeSwitcherProps) {
  const { choice, resolvedId, setChoice, themes } = useTheme();

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    const next: ThemeChoice = value === "system" || isThemeId(value) ? value : "system";
    setChoice(next);
  };

  return (
    <div
      className={
        ["inline-flex items-center gap-1.5 text-xs", className].filter(Boolean).join(" ")
      }
    >
      {/* 解決中のテーマの色見本 (色は index.css の .theme-swatch で定義) */}
      <span aria-hidden className="theme-swatch" data-theme-id={resolvedId} />
      <select
        aria-label="テーマ"
        className={[
          "min-w-0 cursor-pointer rounded-lg border border-line bg-raised px-2 py-1.5 text-ink outline-none transition-colors focus:border-accent",
          compact ? "flex-1 text-[16px]" : "text-xs",
        ].join(" ")}
        value={choice}
        onChange={handleChange}
      >
        <option value="system">システムに従う</option>
        {themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.label}
          </option>
        ))}
      </select>
    </div>
  );
}
