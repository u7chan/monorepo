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
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean): void => {
    setOpen(false);

    // 閉じたあいだフォーカスが body に落ちないよう、起点へ戻す。
    if (refocus) {
      trigger.current?.focus();
    }
  };

  // 開いたら最初の項目へ移す。キーボードではここから矢印で選ぶ。
  useEffect(() => {
    if (open) {
      enabledItems(list.current)[0]?.focus();
    }
  }, [open]);

  // 外側を押したら閉じる。項目の click より先に閉じると選べなくなるので、pointerdown では判定だけする。
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);

    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) {
      // 開いていないときの ↓ / ↑ は、メニューボタンの慣習どおり開く操作として扱う。
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }

      return;
    }

    // 閉じる操作は項目の状態に依らない。全項目が通信中で disabled でも閉じられないと詰まる。
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);

      return;
    }

    if (event.key === "Tab") {
      // フォーカスはそのまま次の要素へ進める。戻すとメニューから出られなくなる。
      close(false);

      return;
    }

    const items = enabledItems(list.current);

    if (items.length === 0) {
      return;
    }

    const index = items.indexOf(document.activeElement as HTMLButtonElement);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items.at(-1)?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <div class="up-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        class="up-menu-button"
        type="button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(true);
          } else {
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open ? (
        <div class="up-menu-list" role="menu" aria-label={props.label} ref={list}>
          {props.items.map((item) => (
            <button
              key={item.label}
              class={item.danger ? "up-menu-item up-menu-item-danger" : "up-menu-item"}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close(true);
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

/** 無効な項目にはフォーカスを置かない。矢印移動の対象からも外す。 */
function enabledItems(list: HTMLDivElement | null): HTMLButtonElement[] {
  return list ? [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')] : [];
}
