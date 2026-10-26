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
import { cn } from "../../lib/cn";
import {
  CUSTOM_PROVIDER_PROBE_LABEL,
  CUSTOM_PROVIDER_PROBE_PENDING_LABEL,
  filterModelIds,
} from "../../lib/customProviders";
import { popoverLeft, popoverTop, popoverWidth } from "../../lib/popoverPlacement";
import { initialSelectMenuIndex, nextSelectMenuIndex, selectMenuPlacement } from "../../lib/selectMenu";
import { CheckIcon } from "../icons";

const MIN_WIDTH = 260;

export type ModelIdPickerProps = {
  /** 現在のモデル ID。一覧の選択状態にだけ使う (入力欄の正は親) */
  value: string;
  /** 取得中。押下中はラベルを変えて無効にする */
  loading: boolean;
  disabled: boolean;
  /**
   * 一覧を取りに行く。キャッシュが新しければ親がそれを返し、失敗時は空配列を返す
   * (エラーの表示は親の結果行が持つ)。reject しない契約。
   */
  onRequest: () => Promise<readonly string[]>;
  onPick: (id: string) => void;
};

/**
 * カスタムプロバイダーのモデル ID 選択。押したときに `/models` の一覧を取り、
 * 検索付きの popover で 1 件選ぶ。入力欄は自由入力のままなので、一覧に無い ID も使える。
 * 開閉と配置の作法は SelectMenu / ModelDefaultPicker に揃える。
 */
export function ModelIdPicker({ value, loading, disabled, onRequest, onPick }: ModelIdPickerProps) {
  const pickerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const requesting = useRef(false);
  const choices = filterModelIds(ids, query);

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (popover === null || trigger === null || list === null) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const width = popoverWidth(Math.max(anchor.width, MIN_WIDTH), viewport.width);
    popover.style.width = `${width}px`;
    const { above, maxHeight } = selectMenuPlacement(anchor, viewport.height);
    // 検索欄と一覧の外枠の高さを引いた分だけを一覧のスクロールに当てる
    const chrome = popover.getBoundingClientRect().height - list.getBoundingClientRect().height;
    list.style.maxHeight = `${Math.max(0, maxHeight - chrome)}px`;
    popover.style.left = `${popoverLeft(anchor, width, viewport.width)}px`;
    popover.style.top = `${popoverTop(anchor, popover.getBoundingClientRect().height, above, viewport.height)}px`;
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は native popover。Escape / light dismiss も観測して aria-expanded へ写す
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

  const focusItem = (index: number) => {
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    items[Math.min(Math.max(index, 0), items.length - 1)]?.focus();
  };

  const openWith = (next: readonly string[]) => {
    const popover = popoverRef.current;
    if (popover === null) return;
    setIds(next);
    setQuery("");
    popover.showPopover();
    place();
    searchRef.current?.focus();
  };

  const toggle = async (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null || disabled || loading || requesting.current) return;
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    requesting.current = true;
    try {
      const next = await onRequest();
      if (next.length > 0) openWith(next);
    } finally {
      requesting.current = false;
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // 既定のスクロールを止める。取得は click と同じ経路に任せ、開いたら検索へ焦点を移す
    event.preventDefault();
    triggerRef.current?.click();
  };

  const stopEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く
    event.stopPropagation();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    stopEscape(event);
    // 検索欄の Enter で外側の登録フォームを submit しない (行の決定は一覧側の button が担う)
    if (event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    // ↓ は選択中の行 (無ければ先頭)、↑ は末尾へ入る。Search 欄から一覧へ抜けるための 1 手
    focusItem(event.key === "ArrowDown" ? initialSelectMenuIndex(value, choices) : choices.length - 1);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    stopEscape(event);
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
    if (direction === null) return;
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    focusItem(nextSelectMenuIndex(current, items.length, direction));
  };

  /** フォーカスが外へ出たら閉じる。native popover は Tab では閉じないため自前で見る */
  const onFocusOut = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    popoverRef.current?.hidePopover();
  };

  const select = (id: string) => {
    popoverRef.current?.hidePopover();
    onPick(id);
  };

  return (
    <span className="contents" onBlur={onFocusOut}>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={pickerId}
        aria-label={CUSTOM_PROVIDER_PROBE_LABEL}
        disabled={disabled || loading}
        onClick={(event) => void toggle(event)}
        onKeyDown={onTriggerKeyDown}
        className="btn-quiet min-h-8 shrink-0 whitespace-nowrap"
      >
        {loading ? CUSTOM_PROVIDER_PROBE_PENDING_LABEL : CUSTOM_PROVIDER_PROBE_LABEL}
      </button>

      <div
        ref={popoverRef}
        id={pickerId}
        popover="auto"
        className="popover-panel fixed inset-auto m-0 overflow-hidden rounded-lg border border-line bg-panel shadow-panel"
      >
        <div className="border-b border-line p-1.5">
          <input
            ref={searchRef}
            type="search"
            className="field min-w-0 text-xs"
            value={query}
            placeholder="モデル ID で絞り込み"
            aria-label="モデル ID を絞り込む"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        {choices.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs text-ink-muted singleColumn:text-xs">該当するモデルがありません。</p>
        ) : null}
        <div
          ref={listRef}
          role="listbox"
          aria-label="モデル一覧"
          onKeyDown={onListKeyDown}
          className={cn(
            "grid scrollbar-thin overflow-x-hidden overflow-y-auto p-1 singleColumn:p-2",
            choices.length === 0 && "hidden",
          )}
        >
          {choices.map((id, index) => (
            <button
              key={id}
              ref={(element) => {
                itemsRef.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={id === value}
              tabIndex={-1}
              onClick={() => select(id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors singleColumn:min-h-11",
                id === value ? "bg-accent-wash" : "hover:bg-accent-wash",
              )}
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink singleColumn:text-sm">{id}</code>
              {id === value ? (
                <span className="shrink-0 text-accent-text">
                  <CheckIcon />
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="border-t border-line px-2.5 py-1.5 text-2xs leading-relaxed text-ink-muted">
          選ぶとモデル ID の欄に入ります。この一覧に無い ID も直接入力できます。
        </p>
      </div>
    </span>
  );
}
