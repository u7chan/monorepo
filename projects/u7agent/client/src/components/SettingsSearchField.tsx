import { SearchIcon } from "./icons";

/**
 * 設定の一覧の検索欄。入力は表示の絞り込みだけに使う (選択・一括操作の母集合は変えない)。
 * 見た目は `field` を共有し、行の高さはタップ領域の下限に合わせる。
 */
export function SettingsSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <label className="relative block min-w-0">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-2 grid place-items-center text-ink-faint"
      >
        <SearchIcon />
      </span>
      <input
        type="search"
        className="field min-h-9 w-full pl-7 text-xs"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
        }}
      />
    </label>
  );
}
