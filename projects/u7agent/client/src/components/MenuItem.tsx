import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn";

export type MenuItemProps = {
  /** 左に置くアイコン (icons.tsx の size-4 のもの) */
  icon?: ReactNode;
  label: ReactNode;
  /** 2 行目。行の高さは min-height で決めるので、1 行の行と基準が揃う */
  description?: ReactNode;
  /**
   * 選択の表現。nav = ページの選択 (塗り)、list = 一覧の項目の選択 (淡い塗り)、add = 追加アクション (破線)。
   * 塗りと淡い塗りを分けるのは、どちらがページでどちらが項目かを一目で見分けるため。
   */
  variant?: "nav" | "list" | "add";
  selected?: boolean;
  /** nav は "page"、一覧の選択は "true" */
  current?: "page" | "true";
  /**
   * 右端の印。今のところ通知の失敗 (⚠) 専用なので、色は警告の意味を持つ warn に固定する
   * (選択中の行では塗りの上で読める on-accent へ切り替える)。
   */
  trailing?: ReactNode;
  /** 破壊的な操作の行。ホバーを待たず文字色で示す */
  danger?: boolean;
  /** メニューの項目は "menuitem"、listbox の項目は "option" (移動は親の role が担うので tabIndex は -1 にする) */
  role?: "menuitem" | "option";
  tabIndex?: number;
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
};

const TONE = {
  add: "border border-dashed border-line text-ink-soft hover:border-accent/50 hover:bg-hover hover:text-accent-text",
  "nav-active": "bg-accent text-on-accent",
  "list-active": "bg-accent-wash text-accent-text",
  idle: "text-ink hover:bg-hover",
  danger: "text-danger-text hover:bg-hover",
} as const;

const ICON_TONE = {
  add: "text-accent-text",
  "nav-active": "text-on-accent",
  "list-active": "text-accent-text",
  idle: "text-ink-soft",
  danger: "text-danger-text",
} as const;

/**
 * 設定のナビと一覧で共通の行。寸法 (高さ / 左右の余白 / 角丸 / アイコンと文字の間隔) を
 * ここ 1 箇所に固定し、ナビと内側の一覧でサイズ感がずれないようにする。
 */
export function MenuItem({
  icon,
  label,
  description,
  variant = "list",
  selected = false,
  current,
  trailing,
  danger = false,
  role,
  tabIndex,
  ref,
  onClick,
}: MenuItemProps) {
  const active = selected && variant !== "add";
  const tone = variant === "add" ? "add" : active ? (`${variant}-active` as const) : danger ? "danger" : "idle";
  return (
    <button
      type="button"
      ref={ref}
      role={role}
      tabIndex={tabIndex}
      aria-current={role === "option" ? undefined : active ? current : undefined}
      aria-selected={role === "option" ? active : undefined}
      onClick={onClick}
      className={cn(
        "flex min-h-7.5 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors",
        TONE[tone],
      )}
    >
      {icon ? (
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center",
            // 2 行の行では行の中央ではなく 1 行目に合わせる (ラベルと説明の境目に浮かないようにする)
            description ? "self-start" : null,
            ICON_TONE[tone],
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="grid min-w-0 flex-1 gap-1">
        {/* アイコンの箱 (size-4) と高さを揃える: 揃わないと self-start のアイコンが 1 行目の中央から外れる */}
        <span className="truncate text-xs leading-4">{label}</span>
        {description ? (
          <span
            className={cn(
              // 淡い塗りの上では ink-muted が 3 台まで落ちるため、説明文は 1 段濃い ink-soft にする
              "truncate text-2xs leading-4",
              tone === "nav-active" ? "text-on-accent/75" : "text-ink-soft",
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center",
            // アイコンの箱と同じく、2 行の行では 1 行目に合わせる
            description ? "self-start" : null,
            tone === "nav-active" ? "text-on-accent" : "text-warn",
          )}
        >
          {trailing}
        </span>
      ) : null}
    </button>
  );
}
