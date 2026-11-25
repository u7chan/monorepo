import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { POPOVER_MARGIN } from "../lib/popoverPlacement";
import { filterSelectMenuOptions, initialSelectMenuIndex } from "../lib/selectMenu";
import { usePopoverShell } from "../hooks/usePopoverShell";
import { useSearchableSelectMenu } from "../hooks/useSearchableSelectMenu";
import { CheckIcon } from "./icons";

export type SelectMenuOption<TValue extends string = string> = {
  value: TValue;
  /** 行とトリガーの主表示 */
  label: string;
  /** トリガーにだけ出す表示名。行が見出しの下で短く書けるときに使う */
  triggerLabel?: string;
  /** 行とトリガーに右端そろえで出す副表示 (ホスト名 / ID など) */
  detail?: string;
  /** 行の下に出す 1 行の説明。折り返さず省略する */
  description?: string;
  /** 行とトリガーの左に出す印 (provider のロゴなど) */
  leading?: ReactNode;
  /** 見出し。1 つ前の行と同じ値なら同じ group にまとめる */
  group?: string;
  /** 選べない行 */
  disabled?: boolean;
};

export type SelectMenuProps<TValue extends string = string> = {
  options: SelectMenuOption<TValue>[];
  value: TValue;
  /** トリガーの読み上げ名 (`aria-label`)。見出しが別にある欄ではこれだけで足りる */
  label: string;
  /** popover の下端に出す注記 */
  note?: ReactNode;
  disabled?: boolean;
  onChange: (value: TValue) => void;
  /** トリガーの寸法だけを呼び出し側で足す (見た目は field のまま)。未指定は今までどおり */
  triggerClassName?: string;
  /** 選択肢が多いときに検索欄を出す。開いたら検索へ焦点を移す */
  searchable?: boolean;
  /** 検索欄の placeholder。何で絞れるかを欄の中で示す */
  searchPlaceholder?: string;
  /** 一覧の上に置く操作 (並び順の切替など)。listbox の外に置く */
  controls?: ReactNode;
};

/**
 * 設定画面の自前 select。行に説明と副表示を出せる点が native の `<select>` と違う。
 * 本体は常時 mount する（条件付き mount だと native popover の開閉と二重管理になる）。
 */
export function SelectMenu<TValue extends string = string>({
  options,
  value,
  label,
  note,
  disabled = false,
  onChange,
  triggerClassName,
  searchable = false,
  searchPlaceholder,
  controls,
}: SelectMenuProps<TValue>) {
  const menuId = useId();
  const triggerId = useId();
  const headerRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  // 絞り込みは開くたびに空へ戻す。前回の検索語で開き直すと、選ぼうとした一覧が欠けて見える
  const visible = searchable ? filterSelectMenuOptions(options, query) : options;
  const groups: { group: string | undefined; items: SelectMenuOption<TValue>[] }[] = [];
  for (const option of visible) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === option.group) last.items.push(option);
    else groups.push({ group: option.group, items: [option] });
  }

  // 注記と検索の行を下端・上端に残すため、上限は一覧からそれらの高さを引いて当てる
  const chrome = () =>
    (noteRef.current?.getBoundingClientRect().height ?? 0) +
    (headerRef.current?.getBoundingClientRect().height ?? 0) +
    2;
  const {
    listRef,
    size: sizeMenu,
    place,
    onSearchKeyDown,
  } = useSearchableSelectMenu({
    value,
    values: visible.map((option) => option.value),
    chrome,
  });

  // 検索できる一覧は行ではなく検索から入る (件数が多い一覧を矢印だけで辿らせない)。絞り込みは
  // 開くたびに空へ戻す (前回の検索語で一覧が欠けて見えるのを避ける)
  const menu = usePopoverShell(place, POPOVER_MARGIN, {
    reposition: ({ place: placeNow }) => placeNow(),
    exitOnBlur: ({ close }) => close(),
    size: sizeMenu,
    openOnArrowKeys: true,
    openFocus: (items) => {
      if (searchable) {
        setQuery("");
        return searchRef.current;
      }
      const index = initialSelectMenuIndex(
        value,
        visible.map((option) => option.value),
      );
      return items[Math.min(Math.max(index, 0), items.length - 1)] ?? null;
    },
  });

  const select = (next: TValue) => {
    if (next !== value) onChange(next);
    menu.close();
  };

  return (
    // トリガーとポップアップを 1 つのフォーカス範囲として扱う (display: contents は欄の flex 配置を変えない)
    <span className="contents" {...menu.containerProps}>
      {/* 長い見出し (会話タイトルなど) で祖先を広げない。min-w-0 が無いと、幅を内容から決める grid / flex の中では
          見出しの 1 行がトリガーの最小幅になり、truncate が効かないまま親ごと横へはみ出す */}
      <button
        type="button"
        {...menu.triggerProps}
        id={triggerId}
        aria-haspopup="listbox"
        aria-controls={menuId}
        aria-label={label}
        popoverTarget={menuId}
        popoverTargetAction="toggle"
        disabled={disabled}
        className={cn(
          "field flex min-w-0 cursor-pointer items-center gap-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-55",
          triggerClassName,
        )}
      >
        {selected?.leading ? <span className="shrink-0">{selected.leading}</span> : null}
        <span className="min-w-0 flex-1 truncate text-xs text-ink">
          {selected?.triggerLabel ?? selected?.label ?? ""}
        </span>
        {selected?.detail ? (
          <span className="shrink-0 font-mono text-2xs text-ink-faint">{selected.detail}</span>
        ) : null}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3 shrink-0 text-ink-faint"
        >
          <path d="M4 6.75 8 10.75 12 6.75" />
        </svg>
      </button>

      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる */}
      <div
        {...menu.popoverProps}
        id={menuId}
        popover="auto"
        className="popover-panel fixed inset-auto m-0 overflow-hidden rounded-lg border border-line bg-panel shadow-panel"
      >
        {/* 検索と操作は一覧の外に置く (listbox の中に option 以外を置かない)。高さは place() が一覧から引く */}
        {searchable || controls ? (
          <div ref={headerRef} className="grid gap-1.5 border-b border-line p-1.5">
            {searchable ? (
              <input
                ref={searchRef}
                type="search"
                className="field min-h-7 min-w-0 px-2 py-0.5 text-xs singleColumn:text-md"
                value={query}
                placeholder={searchPlaceholder ?? "絞り込み"}
                aria-label={searchPlaceholder ?? "絞り込み"}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onSearchKeyDown}
              />
            ) : null}
            {controls}
          </div>
        ) : null}
        {visible.length === 0 ? (
          <p className="px-2.5 py-1.5 text-2xs text-ink-muted singleColumn:text-xs">該当する項目がありません。</p>
        ) : null}
        <div
          ref={listRef}
          role="listbox"
          aria-labelledby={triggerId}
          aria-label={label}
          className={cn(
            "grid scrollbar-thin overflow-x-hidden overflow-y-auto p-1 singleColumn:p-2",
            visible.length === 0 && "hidden",
          )}
        >
          {groups.map((section) => (
            <div key={section.group ?? ""} role="group" aria-label={section.group}>
              {section.group ? (
                <span className="block px-2 pt-1.5 pb-0.5 text-3xs tracking-label text-ink-ghost uppercase singleColumn:text-2xs">
                  {section.group}
                </span>
              ) : null}
              {section.items.map((option) => {
                const index = visible.indexOf(option);
                return (
                  <button
                    key={option.value}
                    ref={menu.itemRef(index)}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    tabIndex={-1}
                    disabled={option.disabled}
                    onClick={() => select(option.value)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 singleColumn:min-h-11",
                      option.value === value ? "bg-accent-wash" : "hover:bg-accent-wash",
                    )}
                  >
                    {option.leading ? <span className="shrink-0">{option.leading}</span> : null}
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-xs text-ink singleColumn:text-sm">{option.label}</span>
                        {option.detail ? (
                          <span className="ml-auto shrink-0 font-mono text-2xs text-ink-faint singleColumn:text-1xs">
                            {option.detail}
                          </span>
                        ) : null}
                      </span>
                      {option.description ? (
                        <span className="truncate text-2xs text-ink-muted singleColumn:text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? (
                      <span className="mt-0.5 shrink-0 text-accent-text">
                        <CheckIcon />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {/* 注記は一覧の外に置く (listbox の中に option 以外を置かない) */}
        {note ? (
          <p
            ref={noteRef}
            className="border-t border-line px-2.5 py-1.5 text-2xs leading-relaxed text-ink-muted singleColumn:text-1xs"
          >
            {note}
          </p>
        ) : null}
      </div>
    </span>
  );
}
