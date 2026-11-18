import { useCallback, useId } from "react";
import { usePopoverShell, type PopoverPlaceInput } from "../../hooks/usePopoverShell";
import { visibleClips } from "../../lib/popoverAnchor";
import { ROW_MENU_MARGIN } from "../../lib/rowMenu";
import { sharedContentMenuPosition } from "../../lib/sharedContentMenu";
import type { SharedContentAction, SharedContentMenuKind } from "../../lib/sharedContents";
import { MenuItem } from "../MenuItem";
import { PencilIcon, MoreIcon, QrCodeIcon, RefreshIcon, StopIcon, TrashIcon } from "../icons";

function iconFor(kind: SharedContentMenuKind) {
  if (kind === "qr") return <QrCodeIcon />;
  if (kind === "rename") return <PencilIcon />;
  if (kind === "update") return <RefreshIcon />;
  if (kind === "stop") return <StopIcon />;
  return <TrashIcon />;
}

export type SharedContentMenuProps = {
  /** ⋯ の読み上げ名に含める共有物の名前 */
  name: string;
  actions: readonly (SharedContentAction & { kind: SharedContentMenuKind })[];
  /** 行から落とした時刻。項目より前の補足として置き、空なら出さない */
  meta?: readonly { label: string; value: string; title?: string }[];
  onSelect: (kind: SharedContentMenuKind) => void;
};

/**
 * 狭い面の共有物カードの ⋯。native popover なので top layer に載り、一覧のスクロール枠に切られない。
 * 外側クリックと Escape は標準の light dismiss に任せ、スクロールでは位置がずれる前に閉じる。
 */
export function SharedContentMenu({ name, actions, meta = [], onSelect }: SharedContentMenuProps) {
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;

  // 一覧の更新でカードが枠の外へ動いたら `null` を返して閉じる (見えていない共有物の操作を残さない)
  const placeMenu = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    return sharedContentMenuPosition(
      trigger.getBoundingClientRect(),
      popover.getBoundingClientRect(),
      viewport,
      visibleClips(trigger),
    );
  }, []);

  // 一覧のスクロールでは閉じ (浮かせたメニューが元のカードから離れて残らないようにする)、
  // 窓の resize では位置だけ取り直し、焦点が外れたら閉じる
  const menu = usePopoverShell(
    placeMenu,
    ROW_MENU_MARGIN,
    ({ cause, place, close }) => (cause === "scroll" ? close() : place()),
    ({ close }) => close(),
  );

  return (
    <>
      <button
        type="button"
        {...menu.triggerProps}
        id={triggerId}
        aria-haspopup="menu"
        aria-label={`${name} のその他の操作`}
        popoverTarget={menuId}
        popoverTargetAction="toggle"
        className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text singleColumn:min-h-11"
      >
        <MoreIcon />
      </button>
      <div
        {...menu.popoverProps}
        id={menuId}
        popover="auto"
        className="popover-panel fixed inset-auto m-0 w-max min-w-44 scrollbar-thin overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-panel"
      >
        {/* メニューの外に置く。role="menu" の中へ非 menuitem を混ぜると、読み上げが項目だけに絞られたときに
            補足が落ちる。開いた直後の焦点は項目へ移すので、この行は browse でだけ読まれる */}
        {meta.length === 0 ? null : (
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-line px-2.5 pt-1.5 pb-2 text-2xs">
            {meta.map((entry) => (
              <div key={entry.label} className="contents">
                <dt className="text-ink-faint">{entry.label}</dt>
                <dd className="m-0 text-right text-ink-soft tabular-nums" title={entry.title}>
                  {entry.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div role="menu" aria-labelledby={triggerId}>
          {actions.map((action, index) => (
            <MenuItem
              key={action.kind}
              ref={menu.itemRef(index)}
              role="menuitem"
              tabIndex={-1}
              icon={iconFor(action.kind)}
              label={action.label}
              description={action.reason}
              descriptionKind="disclosure"
              danger={action.danger === true}
              disabled={action.disabled === true}
              onClick={() => {
                menu.closeBySelection();
                onSelect(action.kind);
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
