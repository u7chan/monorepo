import { useEffect, useRef, useState } from "preact/hooks";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 取り消せない操作。色で区別する。 */
  danger?: boolean;
};

/** 見出しに置く「⋮」。常設すると押す理由が分からない操作を、1 段だけ隠す。 */
export function OverflowMenu(props: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    // 外側を押したら閉じる。項目の click より先に閉じると選べなくなるので、pointerdown で判定するだけにする。
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div class="up-menu" ref={root}>
      <button
        class="up-menu-button"
        type="button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open ? (
        <div class="up-menu-list" role="menu" aria-label={props.label}>
          {props.items.map((item) => (
            <button
              key={item.label}
              class={item.danger ? "up-menu-item up-menu-item-danger" : "up-menu-item"}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
