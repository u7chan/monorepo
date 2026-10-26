import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type FocusEvent,
  type MouseEvent,
} from "react";
import { visibleClips } from "../../lib/popoverAnchor";
import { nextRowMenuIndex, ROW_MENU_MARGIN } from "../../lib/rowMenu";
import { sharedContentMenuPosition } from "../../lib/sharedContentMenu";
import type { SharedContentAction, SharedContentMenuKind } from "../../lib/sharedContents";
import { MenuItem } from "../MenuItem";
import { PencilIcon, MoreIcon, RefreshIcon, StopIcon, TrashIcon } from "../icons";

function iconFor(kind: SharedContentMenuKind) {
  if (kind === "rename") return <PencilIcon />;
  if (kind === "update") return <RefreshIcon />;
  if (kind === "stop") return <StopIcon />;
  return <TrashIcon />;
}

export type SharedContentMenuProps = {
  /** ⋯ の読み上げ名に含める共有物の名前 */
  name: string;
  actions: readonly (SharedContentAction & { kind: SharedContentMenuKind })[];
  onSelect: (kind: SharedContentMenuKind) => void;
};

/**
 * 狭い面の共有物カードの ⋯。native popover なので top layer に載り、一覧のスクロール枠に切られない。
 * 外側クリックと Escape は標準の light dismiss に任せ、スクロールでは位置がずれる前に閉じる。
 */
export function SharedContentMenu({ name, actions, onSelect }: SharedContentMenuProps) {
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  // ⋯ の mousedown は click より先にフォーカスを奪う。その focusout で閉じると直後の click が開き直すため保留する
  const pressingTriggerRef = useRef(false);

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    const viewport = {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
    // 幅 / 高さの上限を測る前に書く。上限が無いと低い窓でメニューが viewport をはみ出す
    popover.style.maxWidth = `${Math.max(0, viewport.width - ROW_MENU_MARGIN * 2)}px`;
    popover.style.maxHeight = `${Math.max(0, viewport.height - ROW_MENU_MARGIN * 2)}px`;
    // 一覧の更新でカードが枠の外へ動いたら、見えていない共有物の操作を残さず閉じる
    const position = sharedContentMenuPosition(
      trigger.getBoundingClientRect(),
      popover.getBoundingClientRect(),
      viewport,
      visibleClips(trigger),
    );
    if (position === null) {
      popover.hidePopover();
      return;
    }
    popover.style.left = `${position.left}px`;
    popover.style.top = `${position.top}px`;
  }, []);

  // 開いている間は commit のたびに置き直す。カードの再描画で ⋯ が動いても追従させる
  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は popover の状態。標準の close (Escape / 外側クリック) もここで観測して aria-expanded へ写す
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onToggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    // 一覧をスクロールしたら閉じる (浮かせたメニューが元のカードから離れて残らないようにする)
    const onScroll = () => popoverRef.current?.hidePopover();
    const onResize = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, place]);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null) return;
    pressingTriggerRef.current = false;
    // 既定の activation behavior と同じトグルを二重に走らせない (開閉は showPopover / hidePopover に寄せる)
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    popover.showPopover();
    place();
    itemsRef.current.find((item) => item !== null && !item.disabled)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
      event.stopPropagation();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // 既定動作 (メニュー外のスクロール) を止める
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextRowMenuIndex(current, items.length, event.key === "ArrowDown" ? "next" : "previous")]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && popoverRef.current?.contains(next)) return;
    if (next === triggerRef.current && pressingTriggerRef.current) {
      pressingTriggerRef.current = false;
      return;
    }
    popoverRef.current?.hidePopover();
  };

  const closeBySelection = () => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && popover.contains(active)) active.blur();
    popover.hidePopover();
    // 確認ダイアログが閉じたときに戻す先を ⋯ にする (メニューの項目は消える)
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        id={triggerId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name} のその他の操作`}
        popoverTarget={menuId}
        popoverTargetAction="toggle"
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
        className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text singleColumn:min-h-11"
      >
        <MoreIcon />
      </button>
      <div
        ref={popoverRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-labelledby={triggerId}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="popover-panel fixed inset-auto m-0 w-max min-w-44 scrollbar-thin overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-panel"
      >
        {actions.map((action, index) => (
          <MenuItem
            key={action.kind}
            ref={(element) => {
              itemsRef.current[index] = element;
            }}
            role="menuitem"
            tabIndex={-1}
            icon={iconFor(action.kind)}
            label={action.label}
            description={action.reason}
            descriptionKind="disclosure"
            danger={action.danger === true}
            disabled={action.disabled === true}
            onClick={() => {
              closeBySelection();
              onSelect(action.kind);
            }}
          />
        ))}
      </div>
    </>
  );
}
