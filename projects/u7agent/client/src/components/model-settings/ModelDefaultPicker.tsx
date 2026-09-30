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
} from "react";
import { AGENT_PICKER_MARGIN, agentPickerPlacement, nextAgentOptionIndex } from "../../lib/agentPicker";
import { cn } from "../../lib/cn";
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const pressingTriggerRef = useRef(false);
  const selected = options.find((option) => option.key === value) ?? options[0];
  const choices = filterDefaultModelOptions(options, query);
  const selectable = options.length > 1;
  const triggerDisabled = disabled || !selectable;

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    // 幅を先に確定させる: max-width で折り返しと内部スクロールが決まり、rect が最終の大きさになる
    popover.style.minWidth = `${anchor.width}px`;
    popover.style.maxWidth = `${viewport.width - AGENT_PICKER_MARGIN * 2}px`;
    const { left, top } = agentPickerPlacement(anchor, popover.getBoundingClientRect(), viewport);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }, []);

  // 開いている間は commit のたびに置き直す (再レンダーより先に resize が走る場合がある)
  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss) も観測して aria-expanded へ写す
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onToggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, []);

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

  const openPicker = () => {
    const popover = popoverRef.current;
    if (popover === null) return;
    // 開いた状態で ↑↓ を受けても showPopover を二重に呼ばない (InvalidStateError を避ける)
    if (popover.matches(":popover-open")) {
      searchRef.current?.focus();
      return;
    }
    setQuery("");
    popover.showPopover();
    place();
    searchRef.current?.focus();
  };

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null || triggerDisabled) return;
    pressingTriggerRef.current = false;
    // popoverTarget の既定 activation behavior は同じトグルを二重に走らせるため止め、開閉を寄せる
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    openPicker();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openPicker();
  };

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    // Enter / Space は native の button に任せる
    if (direction === null) return;
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextAgentOptionIndex(current, items.length, direction)]?.focus();
  };

  const onPopoverBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && popoverRef.current?.contains(next)) return;
    if (next === triggerRef.current && pressingTriggerRef.current) {
      // トリガーへの押下で移るフォーカスは閉じる操作ではない (閉じるかどうかは click 側が決める)
      pressingTriggerRef.current = false;
      return;
    }
    // native popover は Tab では閉じないため、外へのフォーカス移動は自前で閉じる
    popoverRef.current?.hidePopover();
  };

  const selectOption = (key: string | null) => {
    if (key !== value) onChange(key);
    // フォーカスは外さない: blur すると native の復帰が起きず、トリガーへ戻らない
    popoverRef.current?.hidePopover();
  };

  return (
    <>
      <span className="relative flex min-w-0">
        <button
          type="button"
          ref={triggerRef}
          id={triggerId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={pickerId}
          aria-label={selected ? `既定モデルを選択（${selected.name}）` : "既定モデルを選択"}
          popoverTarget={pickerId}
          popoverTargetAction="toggle"
          disabled={triggerDisabled}
          onPointerDown={() => {
            pressingTriggerRef.current = true;
          }}
          onPointerUp={() => {
            pressingTriggerRef.current = false;
          }}
          onPointerCancel={() => {
            pressingTriggerRef.current = false;
          }}
          onClick={toggle}
          onKeyDown={onTriggerKeyDown}
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
        ref={popoverRef}
        id={pickerId}
        popover="auto"
        onKeyDown={onPopoverKeyDown}
        onBlur={onPopoverBlur}
        className="popover-panel fixed inset-auto m-0 w-max overflow-visible rounded-lg border border-line bg-panel p-1 shadow-panel"
      >
        <div className="grid gap-1">
          <input
            ref={searchRef}
            type="search"
            className="field min-h-8 min-w-0 px-2 py-1 text-xs"
            value={query}
            placeholder="モデル名 / ID で検索"
            aria-label="既定モデルを検索"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div
            role="listbox"
            aria-labelledby={triggerId}
            aria-label="既定モデルの候補"
            className="max-h-64 scrollbar-thin overflow-y-auto"
          >
            {choices.length === 0 ? (
              <p className="px-2 py-1.5 text-2xs text-ink-muted">該当するモデルがありません。</p>
            ) : (
              choices.map((option, index) => (
                <button
                  key={option.key ?? ""}
                  ref={(element) => {
                    itemsRef.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={option.key === value}
                  tabIndex={-1}
                  onClick={() => selectOption(option.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent-wash",
                    option.key === value && "bg-accent-wash",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{option.name}</span>
                  {option.detail ? (
                    <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">{option.detail}</span>
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
