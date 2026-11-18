import { useCallback, useId, useRef, useState } from "react";
import { AGENT_PICKER_LIST_MAX_HEIGHT, AGENT_PICKER_MARGIN, agentPickerPlacement } from "../../lib/agentPicker";
import { cn } from "../../lib/cn";
import { usePopoverShell, type PopoverPlaceInput } from "../../hooks/usePopoverShell";
import { filterDefaultModelOptions, type DefaultModelOption } from "../../lib/modelSettings";

/**
 * アプリ既定モデルのピッカー。候補（選択済みモデル）は 1,500 件規模になり得て native `<select>`
 * では検索できないため、AgentPicker と同じ native popover + listbox で名前 / ID の検索を付ける。
 * 本体は常時 mount する（条件付き mount だと標準の開閉と state が二重管理になる）。
 */
export function ModelDefaultPicker({
  options,
  value,
  disabled,
  onChange,
}: {
  options: DefaultModelOption[];
  value: string | null;
  disabled: boolean;
  onChange: (key: string | null) => void;
}) {
  const pickerId = useId();
  const triggerId = `${pickerId}-trigger`;
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.key === value) ?? options[0];
  const choices = filterDefaultModelOptions(options, query);
  const selectable = options.length > 1;
  const triggerDisabled = disabled || !selectable;

  // 幅を先に確定させる: max-width で折り返しと内部スクロールが決まり、rect が最終の大きさになる
  const sizePicker = useCallback(({ popover, trigger, viewport, margin }: PopoverPlaceInput & { margin: number }) => {
    if (trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    popover.style.minWidth = `${anchor.width}px`;
    popover.style.maxWidth = `${viewport.width - margin * 2}px`;
    const list = listRef.current;
    if (list !== null) {
      // 高さの上限はスクロールする一覧に当てる。検索欄と外枠の高さを popover と一覧の rect の差で測り、
      // 低い viewport (ソフトキーボード表示中を含む) では既定より縮める
      const chrome = popover.getBoundingClientRect().height - list.getBoundingClientRect().height;
      const available = viewport.height - margin * 2 - chrome;
      list.style.maxHeight = `${Math.max(0, Math.min(AGENT_PICKER_LIST_MAX_HEIGHT, available))}px`;
    }
  }, []);

  const place = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    return agentPickerPlacement(trigger.getBoundingClientRect(), popover.getBoundingClientRect(), viewport);
  }, []);

  // 開いた直後は検索欄へ入る (候補が多く、絞り込む方が速い)。絞り込みは開くたびに空へ戻す
  // (前回の検索語で開き直すと、選ぼうとした一覧が欠けて見える)。外への移動で閉じるのは hook が持つ
  const picker = usePopoverShell(place, AGENT_PICKER_MARGIN, {
    reposition: ({ place: placeNow }) => placeNow(),
    exitOnBlur: ({ close }) => close(),
    size: sizePicker,
    openOnArrowKeys: true,
    openFocus: () => {
      setQuery("");
      return searchRef.current;
    },
  });

  const selectOption = (key: string | null) => {
    if (key !== value) onChange(key);
    // フォーカスは外さない: blur すると native の復帰が起きず、トリガーへ戻らない
    picker.close();
  };

  return (
    <>
      <span className="relative flex min-w-0">
        <button
          type="button"
          {...picker.triggerProps}
          id={triggerId}
          aria-haspopup="listbox"
          aria-controls={pickerId}
          aria-label={selected ? `既定モデルを選択（${selected.name}）` : "既定モデルを選択"}
          popoverTarget={pickerId}
          popoverTargetAction="toggle"
          disabled={triggerDisabled}
          className={cn(
            "field flex w-full cursor-pointer items-center gap-2 py-1.5 pr-8 pl-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{selected?.name ?? ""}</span>
          {selected?.detail ? (
            <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">{selected.detail}</span>
          ) : null}
        </button>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-2.5 size-3 shrink-0 self-center text-ink-faint"
        >
          <path d="M4 6.75 8 10.75 12 6.75" />
        </svg>
      </span>
      {/* popover の UA 既定 (fixed 以外に margin / border / padding を持つ) を打ち消してから
          テーマのトークンを当てる。位置と幅は place() が left / top / min-width / max-width を直接書く */}
      <div
        {...picker.popoverProps}
        {...picker.exitProps}
        id={pickerId}
        popover="auto"
        className="popover-panel fixed inset-auto m-0 w-max overflow-visible rounded-lg border border-line bg-panel p-1 shadow-panel singleColumn:p-2"
      >
        <div className="grid gap-1">
          <input
            ref={searchRef}
            type="search"
            className="field min-h-8 min-w-0 px-2 py-1 text-xs singleColumn:text-md"
            value={query}
            placeholder="モデル名 / ID で検索"
            aria-label="既定モデルを検索"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div
            ref={listRef}
            role="listbox"
            aria-labelledby={triggerId}
            aria-label="既定モデルの候補"
            className="scrollbar-thin overflow-y-auto"
          >
            {choices.length === 0 ? (
              <p className="px-2 py-1.5 text-2xs text-ink-muted singleColumn:text-xs">該当するモデルがありません。</p>
            ) : (
              choices.map((option, index) => (
                <button
                  key={option.key ?? ""}
                  ref={picker.itemRef(index)}
                  type="button"
                  role="option"
                  aria-selected={option.key === value}
                  tabIndex={-1}
                  onClick={() => selectOption(option.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent-wash singleColumn:min-h-11",
                    option.key === value && "bg-accent-wash",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-ink singleColumn:text-sm">{option.name}</span>
                  {option.detail ? (
                    <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint singleColumn:text-1xs">
                      {option.detail}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
