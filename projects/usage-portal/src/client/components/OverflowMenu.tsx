import { useEffect, useRef, useState } from "preact/hooks";

export type MenuAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 取り消せない操作。色で区別する。 */
  danger?: boolean;
};

/** 公式ページなど、アプリの外を開く項目。 */
export type MenuLink = { label: string; href: string };

export type MenuSubmenu = { label: string; items: readonly (MenuAction | MenuLink)[] };

export type MenuItem = MenuAction | MenuLink | MenuSubmenu;

/** 見出しに置く「⋮」。常設すると押す理由が分からない操作を、1 段だけ隠す。 */
export function OverflowMenu(props: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const submenuList = useRef<HTMLDivElement>(null);
  const submenuTrigger = useRef<HTMLButtonElement | null>(null);

  const close = (refocus: boolean): void => {
    setOpen(false);
    setSubmenu(null);

    // 閉じたあいだフォーカスが body に落ちないよう、起点へ戻す。
    if (refocus) {
      trigger.current?.focus();
    }
  };

  const closeSubmenu = (refocus: boolean): void => {
    setSubmenu(null);

    if (refocus) {
      submenuTrigger.current?.focus();
    }
  };

  // 開いたら最初の項目へ移す。キーボードではここから矢印で選ぶ。
  useEffect(() => {
    if (open) {
      enabledItems(list.current)[0]?.focus();
    }
  }, [open]);

  // 子メニューも同じく先頭へ移す。開いた項目の続きから矢印で選べる。
  useEffect(() => {
    if (open && submenu) {
      enabledItems(submenuList.current)[0]?.focus();
    }
  }, [open, submenu]);

  // 外側を押したら閉じる。項目の click より先に閉じると選べなくなるので、pointerdown では判定だけする。
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setSubmenu(null);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);

    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (
    event: KeyboardEvent,
    container: HTMLDivElement | null,
    parent: HTMLButtonElement | null,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();

      // 子メニューでは 1 段だけ戻す。全体を閉じると、選び直すのに開き直しが要る。
      if (parent) {
        closeSubmenu(true);
      } else {
        close(true);
      }

      return;
    }

    if (event.key === "Tab") {
      // フォーカスはそのまま次の要素へ進める。戻すとメニューから出られなくなる。
      close(false);

      return;
    }

    if (event.key === "ArrowLeft" && parent) {
      event.preventDefault();
      closeSubmenu(true);

      return;
    }

    const items = enabledItems(container);

    if (items.length === 0) {
      return;
    }

    const index = items.indexOf(document.activeElement as HTMLElement);

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
      case "ArrowRight": {
        // 子メニューを持つ項目でだけ開く。リンクや通常の操作では右へ抜けない。
        const focused = items[index];

        if (focused instanceof HTMLButtonElement && focused.dataset.submenu === "true") {
          event.preventDefault();
          focused.click();
        }

        break;
      }
      default:
        break;
    }
  };

  const renderLeaf = (item: MenuAction | MenuLink) =>
    isLink(item) ? (
      <a
        key={item.label}
        class="up-menu-item"
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        onClick={() => close(true)}
      >
        {item.label}
      </a>
    ) : (
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
    );

  return (
    <div class="up-menu" ref={root}>
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
        onKeyDown={(event) => {
          // 開いていないときの ↓ / ↑ は、メニューボタンの慣習どおり開く操作として扱う。
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open ? (
        <div
          class="up-menu-list"
          role="menu"
          aria-label={props.label}
          ref={list}
          data-menu="true"
          onKeyDown={(event) => onKeyDown(event, list.current, null)}
        >
          {props.items.map((item) =>
            isSubmenu(item) ? (
              <div class="up-menu-entry" key={item.label} role="none">
                <button
                  class="up-menu-item up-menu-item-submenu"
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={submenu === item.label}
                  data-submenu="true"
                  onClick={(event) => {
                    if (submenu === item.label) {
                      closeSubmenu(false);

                      return;
                    }

                    submenuTrigger.current = event.currentTarget;
                    setSubmenu(item.label);
                  }}
                >
                  {item.label}
                  <svg class="up-menu-submenu-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path
                      d="m6 4 4 4-4 4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
                {submenu === item.label ? (
                  <div
                    class="up-menu-list up-menu-submenu"
                    role="menu"
                    aria-label={item.label}
                    ref={submenuList}
                    data-menu="true"
                    onKeyDown={(event) => {
                      // 矢印と Escape はこの段だけで扱う。親の段の移動と混ざらないようにする。
                      event.stopPropagation();
                      onKeyDown(event, submenuList.current, submenuTrigger.current);
                    }}
                  >
                    {item.items.map(renderLeaf)}
                  </div>
                ) : null}
              </div>
            ) : (
              renderLeaf(item)
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function isSubmenu(item: MenuItem): item is MenuSubmenu {
  return "items" in item;
}

function isLink(item: MenuAction | MenuLink): item is MenuLink {
  return "href" in item;
}

/** 無効な項目にはフォーカスを置かない。矢印移動の対象からも、入れ子の項目も外す。 */
function enabledItems(container: HTMLDivElement | null): HTMLElement[] {
  if (!container) {
    return [];
  }

  return [...container.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')].filter(
    (item) => item.closest("[data-menu]") === container,
  );
}
