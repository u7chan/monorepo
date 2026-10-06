import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import { popoverLeft, popoverTop, popoverWidth } from "../lib/popoverPlacement";
import { initialSelectMenuIndex, nextSelectMenuIndex, selectMenuPlacement } from "../lib/selectMenu";
import { CheckIcon } from "./icons";

/** 一覧の幅の下限。説明の 1 行が読める幅を確保する */
const MIN_WIDTH = 260;

export type SelectMenuOption<TValue extends string = string> = {
  value: TValue;
  /** 行とトリガーの主表示 */
  label: string;
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
}: SelectMenuProps<TValue>) {
  const menuId = useId();
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const groups: { group: string | undefined; items: SelectMenuOption<TValue>[] }[] = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === option.group) last.items.push(option);
    else groups.push({ group: option.group, items: [option] });
  }

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (popover === null || trigger === null || list === null) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    // 幅と高さの上限を先に確定させる: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
    const width = popoverWidth(Math.max(anchor.width, MIN_WIDTH), viewport.width);
    popover.style.width = `${width}px`;
    const { above, maxHeight } = selectMenuPlacement(anchor, viewport.height);
    // 注記を下端に残すため、上限は一覧から注記の高さを引いて当てる
    const chrome = (noteRef.current?.getBoundingClientRect().height ?? 0) + 2;
    list.style.maxHeight = `${Math.max(0, maxHeight - chrome)}px`;
    popover.style.left = `${popoverLeft(anchor, width, viewport.width)}px`;
    popover.style.top = `${popoverTop(anchor, popover.getBoundingClientRect().height, above, viewport.height)}px`;
  }, []);

  // 開いている間は commit のたびに置き直す (行数や注記の高さが変わっても追従させる)
  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss / Tab での退出) を観測して写す
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "open") return;
      setOpen(false);
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, []);

  // 開いている間だけ位置を取り直す。scroll は capture で受けないと、設定の本文のスクロールを拾えない
  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  const focusItem = (index: number) => {
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    items[Math.min(Math.max(index, 0), items.length - 1)]?.focus();
  };

  const openMenu = () => {
    const popover = popoverRef.current;
    if (popover === null) return;
    popover.showPopover();
    place();
    setOpen(true);
    focusItem(
      initialSelectMenuIndex(
        value,
        options.map((option) => option.value),
      ),
    );
  };

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null) return;
    // popoverTarget はトリガー自身の押下を light dismiss の対象外にするためだけに付ける。既定の activation
    // behavior は同じトグルを二重に走らせるので止め、開閉を showPopover / hidePopover に寄せる
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    openMenu();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // 既定動作 (ページのスクロール) を止め、native select と同じく選択中の行から入る
    event.preventDefault();
    if (popoverRef.current?.matches(":popover-open")) return;
    openMenu();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
      event.stopPropagation();
      return;
    }
    const direction =
      event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowUp"
          ? "previous"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    // Enter / Space は native の button に任せる (押した行がそのまま確定する)
    if (direction === null) return;
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    focusItem(nextSelectMenuIndex(current, items.length, direction));
  };

  /** フォーカスが外へ出たら閉じる。native popover は Tab では閉じないため自前で見る */
  const onFocusOut = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    // トリガー → 行、行 → 行の移動は閉じる操作ではない
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    popoverRef.current?.hidePopover();
  };

  const select = (next: TValue) => {
    if (next !== value) onChange(next);
    // フォーカスは外さない: blur すると native の復帰が起きず、トリガーへ戻らない
    popoverRef.current?.hidePopover();
  };

  return (
    // トリガーとポップアップを 1 つのフォーカス範囲として扱う (display: contents は欄の flex 配置を変えない)
    <span className="contents" onBlur={onFocusOut}>
      <button
        type="button"
        ref={triggerRef}
        id={triggerId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        popoverTarget={menuId}
        popoverTargetAction="toggle"
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        className="field flex cursor-pointer items-center gap-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-55"
      >
        {selected?.leading ? <span className="shrink-0">{selected.leading}</span> : null}
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{selected?.label ?? ""}</span>
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
        ref={popoverRef}
        id={menuId}
        popover="auto"
        className="popover-panel fixed inset-auto m-0 overflow-hidden rounded-lg border border-line bg-panel shadow-panel"
      >
        <div
          ref={listRef}
          role="listbox"
          aria-labelledby={triggerId}
          aria-label={label}
          onKeyDown={onListKeyDown}
          className="grid scrollbar-thin overflow-x-hidden overflow-y-auto p-1"
        >
          {groups.map((section) => (
            <div key={section.group ?? ""} role="group" aria-label={section.group}>
              {section.group ? (
                <span className="block px-2 pt-1.5 pb-0.5 text-3xs tracking-label text-ink-ghost uppercase">
                  {section.group}
                </span>
              ) : null}
              {section.items.map((option) => {
                const index = options.indexOf(option);
                return (
                  <button
                    key={option.value}
                    ref={(element) => {
                      itemsRef.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    tabIndex={-1}
                    disabled={option.disabled}
                    onClick={() => select(option.value)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                      option.value === value ? "bg-accent-wash" : "hover:bg-accent-wash",
                    )}
                  >
                    {option.leading ? <span className="shrink-0">{option.leading}</span> : null}
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-xs text-ink">{option.label}</span>
                        {option.detail ? (
                          <span className="ml-auto shrink-0 font-mono text-2xs text-ink-faint">{option.detail}</span>
                        ) : null}
                      </span>
                      {option.description ? (
                        <span className="truncate text-2xs text-ink-muted">{option.description}</span>
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
          <p ref={noteRef} className="border-t border-line px-2.5 py-1.5 text-2xs leading-relaxed text-ink-muted">
            {note}
          </p>
        ) : null}
      </div>
    </span>
  );
}
