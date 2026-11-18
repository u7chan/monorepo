import { Fragment, useCallback, useId, useRef, type ReactNode } from "react";
import { usePopoverShell, type PopoverPlaceInput } from "../hooks/usePopoverShell";
import {
  rowMenuAnchorVisible,
  rowMenuDescriptionKind,
  rowMenuPlacement,
  ROW_MENU_MARGIN,
  type RowMenuAction,
  type RowMenuActionKind,
} from "../lib/rowMenu";
import { cn } from "../lib/cn";
import { visibleClips } from "../lib/popoverAnchor";
import { MenuItem } from "./MenuItem";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GitBranchIcon,
  MoreIcon,
  MoveIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  ShareIcon,
  SparkleIcon,
  TrashIcon,
} from "./icons";

/** 種別ごとのアイコン。描画側に条件分岐を残さないため、種別からここで引く (全画面ぶんを 1 箇所に置く) */
const ACTION_ICONS: Record<RowMenuActionKind, ReactNode> = {
  "copy-path": <CopyIcon />,
  "copy-absolute-path": <CopyIcon />,
  "copy-session-id": <CopyIcon />,
  share: <ShareIcon />,
  download: <DownloadIcon small />,
  rename: <PencilIcon />,
  "title-summary": <SparkleIcon />,
  pin: <PinIcon />,
  move: <MoveIcon />,
  handoff: <MoveIcon />,
  fork: <GitBranchIcon />,
  delete: <TrashIcon />,
  "new-chat": <PlusIcon />,
};

export type RowMenuProps<K extends RowMenuActionKind> = {
  /** ⋯ の読み上げ名に含める行の名前 */
  name: string;
  /** 出す項目。空配列は受けない (項目 0 の行の空きスロットは呼び出し側が置く) */
  actions: readonly RowMenuAction<K>[];
  /** 直前の選択 (コピー) が成功した直後。選択で項目が消えるため、結果を ⋯ の位置に出す */
  copied?: boolean;
  /**
   * singleColumn のタップ領域。`toolbar` は幅も 44px へ広げる (行では行の高さに揃えて 24px 幅のまま)。
   * 寸法はこの部品が持ち、呼び出し側は用途だけを渡す
   */
  touchTarget?: "row" | "toolbar";
  onSelect: (kind: K) => void;
};

/**
 * 行の ⋯ と操作メニュー。外装は native `popover="auto"` なので top layer に載り、ツリーの
 * スクロール枠に切られない。外側クリックと Escape の終了は標準の light dismiss に任せ、
 * 自前で閉じる経路 (項目の選択 / Tab での退出) だけ `hidePopover()` を通す。
 * 本体は常時 mount する (React の条件付き mount で出し入れすると標準の開閉と二重管理になる)。
 */
export function RowMenu<K extends RowMenuActionKind>({
  name,
  actions,
  copied = false,
  touchTarget = "row",
  onSelect,
}: RowMenuProps<K>) {
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  // 幅 / 高さの上限は hook が margin から書き、ここは ⋯ の箱を基準にした left / top だけを返す。
  // 箱 (24px) は button ではなくこの span なので、place が見る rect を行の高さまで広げない
  const placeMenu = useCallback(({ popover, viewport }: PopoverPlaceInput) => {
    const anchorElement = anchorRef.current;
    if (anchorElement === null) return null;
    const anchor = anchorElement.getBoundingClientRect();
    // ⋯ が clip (ツリーのスクロール枠 / viewport) の外へ出ていたら開かない (見えていない行の操作を残さない)
    if (!rowMenuAnchorVisible(anchor, visibleClips(anchorElement))) return null;
    return rowMenuPlacement(anchor, popover.getBoundingClientRect(), viewport);
  }, []);

  // ツリーのスクロールでも閉じず ⋯ へ追随させ、焦点が外れたら閉じる (この画面の殻の使い方)
  const menu = usePopoverShell(
    placeMenu,
    ROW_MENU_MARGIN,
    ({ place }) => place(),
    ({ close }) => close(),
  );

  return (
    <>
      <button
        type="button"
        {...menu.triggerProps}
        id={triggerId}
        aria-haspopup="menu"
        aria-label={copied ? "コピーしました" : `${name} の操作`}
        title={copied ? "コピーしました" : undefined}
        popoverTarget={menuId}
        popoverTargetAction="toggle"
        className={cn(
          "group grid h-6 w-6 shrink-0 place-items-center singleColumn:h-11",
          touchTarget === "toolbar" && "singleColumn:w-11",
        )}
      >
        {/* 見た目の箱 (24px) と操作領域 (singleColumn は行いっぱいの 44px) を分ける。アンカーは外側の button ではなく
            この箱で、 `place()` が読む rect を広げない (行が半分隠れた状態で開いた直後に閉じる経路を増やさない) */}
        <span
          ref={anchorRef}
          className={cn(
            "grid size-6 place-items-center rounded-md transition-colors",
            copied ? "text-ok" : "text-ink-faint group-hover:bg-raised group-hover:text-ink",
          )}
        >
          {copied ? <CheckIcon /> : <MoreIcon />}
        </span>
      </button>
      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置は place() が left / top を直接書く。高さの上限を超えたぶんは
          ここ (popover 自身) のスクロールへ逃がす */}
      <div
        {...menu.popoverProps}
        {...menu.exitProps}
        id={menuId}
        popover="auto"
        role="menu"
        aria-labelledby={triggerId}
        className="popover-panel fixed inset-auto m-0 w-max min-w-40 scrollbar-thin overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-panel singleColumn:min-w-48 singleColumn:p-2"
      >
        {actions.map((action, index) => (
          <Fragment key={action.kind}>
            {/* 破壊的な操作は色だけでなく位置 (末尾) と区切りでも示す */}
            {action.danger === true && index > 0 ? <div aria-hidden="true" className="mx-1 my-1 h-px bg-line" /> : null}
            <MenuItem
              ref={menu.itemRef(index)}
              role="menuitem"
              tabIndex={-1}
              icon={ACTION_ICONS[action.kind]}
              label={action.label}
              description={action.description}
              descriptionKind={rowMenuDescriptionKind(action)}
              status={action.status}
              danger={action.danger}
              disabled={action.disabled === true}
              onClick={() => {
                // 確認ダイアログ / prompt をメニューの背後に出さない (開いたままだと隠れる)
                menu.closeBySelection();
                onSelect(action.kind);
              }}
            />
          </Fragment>
        ))}
      </div>
    </>
  );
}
