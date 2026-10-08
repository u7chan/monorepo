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
import {
  nextRowMenuIndex,
  rowMenuAnchorVisible,
  rowMenuPlacement,
  type RowMenuAction,
  type RowMenuActionKind,
  type RowMenuRect,
} from "../lib/rowMenu";
import { MenuItem } from "./MenuItem";
import { DownloadIcon, MoreIcon, PencilIcon, PinIcon, PlusIcon, TrashIcon } from "./icons";

/** 種別ごとのアイコン。描画側に条件分岐を残さないため、種別からここで引く (全画面ぶんを 1 箇所に置く) */
const ACTION_ICONS: Record<RowMenuActionKind, ReactNode> = {
  download: <DownloadIcon small />,
  rename: <PencilIcon />,
  pin: <PinIcon />,
  delete: <TrashIcon />,
  "new-chat": <PlusIcon />,
};

/** overflow-y を持つ直近の祖先 = ツリーのスクロール枠。popover は top layer に載るので切られはしないが、
 * ⋯ が枠の外へスクロールしたら追従せず閉じる (見えていない行のメニューを残さない) */
function scrollClip(element: HTMLElement): RowMenuRect | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent.getBoundingClientRect();
  }
  return null;
}

function visibleClips(element: HTMLElement): RowMenuRect[] {
  const viewport = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  const clip = scrollClip(element);
  return clip === null ? [viewport] : [viewport, clip];
}

export type RowMenuProps<K extends RowMenuActionKind> = {
  /** ⋯ の読み上げ名に含める行の名前 */
  name: string;
  /** 出す項目。空配列は受けない (項目 0 の行の空きスロットは呼び出し側が置く) */
  actions: readonly RowMenuAction<K>[];
  onSelect: (kind: K) => void;
};

/**
 * 行の ⋯ と操作メニュー。外装は native `popover="auto"` なので top layer に載り、ツリーの
 * スクロール枠に切られない。外側クリックと Escape の終了は標準の light dismiss に任せ、
 * 自前で閉じる経路 (項目の選択 / Tab での退出) だけ `hidePopover()` を通す。
 * 本体は常時 mount する (React の条件付き mount で出し入れすると標準の開閉と二重管理になる)。
 */
export function RowMenu<K extends RowMenuActionKind>({ name, actions, onSelect }: RowMenuProps<K>) {
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  // ⋯ の mousedown は click より先にフォーカスを奪う。その focusout で閉じると直後の click が
  // 開き直してトグルが効かないため、⋯ を押している間だけ focusout での終了を保留する
  const pressingTriggerRef = useRef(false);

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    if (!rowMenuAnchorVisible(anchor, visibleClips(trigger))) {
      popover.hidePopover();
      return;
    }
    const { left, top } = rowMenuPlacement(anchor, popover.getBoundingClientRect(), {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }, []);

  // 開いている間は commit のたびに置き直す。window の resize ハンドラは React の再レンダー
  // (サイドバーの docked ⇄ overlay など) より先に走り、動く前の rect を読んでしまう。commit 後なら
  // DOM は更新済みなので、ここで読む rect が新しい配置を指す
  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss) もここで観測して aria-expanded へ写す
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onToggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, []);

  // 開いている間だけ位置を取り直す。scroll は capture で受けないとツリーのスクロール枠の分を拾えない
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

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null) return;
    pressingTriggerRef.current = false;
    // popoverTarget は ⋯ 自身の押下を light dismiss の対象外にするためだけに付ける。既定の activation
    // behavior は同じトグルを二重に走らせるので止め、開閉を showPopover / hidePopover に寄せる
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    popover.showPopover();
    place();
    itemsRef.current[0]?.focus();
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
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextRowMenuIndex(current, items.length, event.key === "ArrowDown" ? "next" : "previous")]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && popoverRef.current?.contains(next)) return;
    if (next === triggerRef.current && pressingTriggerRef.current) {
      // ⋯ への押下で移るフォーカスは閉じる操作ではない (閉じるかどうかは click 側が決める)
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
    // 選択後は ⋯ へ焦点を戻す (メニューの項目は消えるため、この後の確認ダイアログが「開いたボタン」を
    // 控えて閉じたときに戻せるようにする)
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
        aria-label={`${name} の操作`}
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
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-ink"
      >
        <MoreIcon />
      </button>
      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置は place() が left / top を直接書く */}
      <div
        ref={popoverRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-labelledby={triggerId}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="popover-panel fixed inset-auto m-0 w-max min-w-40 overflow-visible rounded-lg border border-line bg-panel p-1 shadow-panel"
      >
        {actions.map((action, index) => (
          <MenuItem
            key={action.kind}
            ref={(element) => {
              itemsRef.current[index] = element;
            }}
            role="menuitem"
            tabIndex={-1}
            icon={ACTION_ICONS[action.kind]}
            label={action.label}
            description={action.description}
            danger={action.danger}
            onClick={() => {
              // 確認ダイアログ / prompt をメニューの背後に出さない (開いたままだと隠れる)
              closeBySelection();
              onSelect(action.kind);
            }}
          />
        ))}
      </div>
    </>
  );
}
