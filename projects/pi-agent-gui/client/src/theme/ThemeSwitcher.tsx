import type { ChangeEvent } from "react";
import { SelectField } from "../components/SelectField";
import { useTheme } from "./ThemeProvider";
import { isThemeId, type ThemeChoice } from "./themes";

export type ThemeSwitcherProps = {
  /** レイアウト調整用のクラスを外部から差し込む */
  className?: string;
  /** ドロワーなど compact な領域向け。iOS の focus 時ズームを避けるため 16px 以上にする */
  compact?: boolean;
};

/** コンパクトなテーマ選択 (desktop の Topbar と、drawer の下部に置く) */
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
      <SelectField
        aria-label="テーマ"
        className={compact ? "py-1.5 pl-2 text-[16px]" : "py-1.5 pl-2 text-xs"}
        wrapperClassName={compact ? "min-w-0 flex-1" : undefined}
        value={choice}
        onChange={handleChange}
      >
        <option value="system">システムに従う</option>
        {themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.label}
          </option>
        ))}
      </SelectField>
    </div>
  );
}
