import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn";
import type { RowMenuDescriptionKind } from "../lib/rowMenu";
import { CheckIcon } from "./icons";

export type MenuItemProps = {
  /** 左に置くアイコン (icons.tsx の size-4 のもの) */
  icon?: ReactNode;
  label: ReactNode;
  /** 2 行目。行の高さは min-height で決めるので、1 行の行と基準が揃う */
  description?: ReactNode;
  /**
   * 2 行目の区分。singleColumn では `note` だけを隠す (`disclosure` は押す前に知る条件なので残す)。
   * 未指定は `disclosure` に倒すため、新しく足した項目の説明が勝手に消えることはない。
   */
  descriptionKind?: RowMenuDescriptionKind;
  /**
   * 選択の表現。nav = ページの選択 (塗り)、list = 一覧の項目の選択 (淡い塗り)、
   * choice = 択一の一覧 (枠 + 選択のチェック)、add = 追加アクション (破線)。
   * 塗りと淡い塗りを分けるのは、どちらがページでどちらが項目かを一目で見分けるため。
   * choice だけ枠とチェックを持つのは、選択の淡い塗りだけでは行の範囲が地に埋もれ、
   * 押せる行かどうかが一目で分からないため。
   */
  variant?: "nav" | "list" | "choice" | "add";
  selected?: boolean;
  /** nav は "page"、一覧の選択は "true" */
  current?: "page" | "true";
  /**
   * 右端の印。今のところ通知の失敗 (⚠) 専用なので、色は警告の意味を持つ warn に固定する
   * (選択中の行では塗りの上で読める on-accent へ切り替える)。
   */
  trailing?: ReactNode;
  /** 右端の短い状態。面にはせず、読み上げはラベルの後に続ける */
  status?: { text: string; tone?: "accent" | "danger" | "warn" | "muted" };
  /** 破壊的な操作の行。ホバーを待たず文字色で示す */
  danger?: boolean;
  /** 押せない行。できない理由は `description` に出し、項目ごと隠さない */
  disabled?: boolean;
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
  choice: "border border-line text-ink hover:border-accent/50 hover:bg-hover",
  "choice-active": "border border-accent/60 bg-accent-wash text-accent-text",
  idle: "text-ink hover:bg-hover",
  danger: "text-danger-text hover:bg-hover",
  disabled: "cursor-not-allowed text-ink-faint",
} as const;

const ICON_TONE = {
  add: "text-accent-text",
  "nav-active": "text-on-accent",
  "list-active": "text-accent-text",
  choice: "text-ink-soft",
  "choice-active": "text-accent-text",
  idle: "text-ink-soft",
  danger: "text-danger-text",
  disabled: "text-ink-ghost",
} as const;

/** 未選択の行のトーン。枠を持つ choice だけ idle と別にする */
const IDLE_TONE = { nav: "idle", list: "idle", choice: "choice", add: "add" } as const;

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
  descriptionKind = "disclosure",
  status,
  trailing,
  danger = false,
  disabled = false,
  role,
  tabIndex,
  ref,
  onClick,
}: MenuItemProps) {
  const active = selected && variant !== "add";
  const tone = disabled ? "disabled" : active ? (`${variant}-active` as const) : danger ? "danger" : IDLE_TONE[variant];
  // 2 行の行では行の中央ではなく 1 行目に合わせる (ラベルと説明の境目に浮かないようにする)。singleColumn で
  // 補足を隠したときは 1 行の行に戻るので、中央寄せへ戻す (説明を隠す条件と同じ CSS で切り替える)
  const slotAlign =
    description === undefined ? null : cn("self-start", descriptionKind === "note" && "singleColumn:self-center");
  return (
    <button
      type="button"
      ref={ref}
      role={role}
      tabIndex={tabIndex}
      disabled={disabled}
      aria-current={role === "option" ? undefined : active ? current : undefined}
      aria-selected={role === "option" ? active : undefined}
      onClick={onClick}
      className={cn(
        "flex min-h-7.5 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors singleColumn:min-h-11",
        TONE[tone],
      )}
    >
      {icon ? (
        <span className={cn("grid size-4 shrink-0 place-items-center singleColumn:size-5", slotAlign, ICON_TONE[tone])}>
          {icon}
        </span>
      ) : null}
      <span className="grid min-w-0 flex-1 gap-1">
        {/* アイコンの箱とラベルの行送りを揃える: 揃わないと 1 行目のアイコンが中央から外れる */}
        <span className="truncate text-xs leading-4 singleColumn:text-sm singleColumn:leading-5">{label}</span>
        {description ? (
          <span
            className={cn(
              // 淡い塗りの上では ink-muted が 3 台まで落ちるため、説明文は 1 段濃い ink-soft にする
              "truncate text-2xs leading-4 singleColumn:text-xs singleColumn:leading-5",
              descriptionKind === "note" && "singleColumn:hidden",
              tone === "nav-active" ? "text-on-accent/75" : "text-ink-soft",
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
      {status ? (
        <span
          className={cn(
            "shrink-0 text-2xs tabular-nums",
            status.tone === "accent"
              ? "text-accent-text"
              : status.tone === "danger"
                ? "text-danger-text"
                : status.tone === "warn"
                  ? "text-warn-text"
                  : "text-ink-faint",
          )}
        >
          {status.text}
        </span>
      ) : null}
      {/* 選択のチェックは添えるだけなので読み上げない (選択は aria-current が伝える) */}
      {active && variant === "choice" ? (
        <span className={cn("grid size-4 shrink-0 place-items-center singleColumn:size-5", slotAlign, ICON_TONE[tone])}>
          <CheckIcon />
        </span>
      ) : null}
      {trailing ? (
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center singleColumn:size-5",
            // アイコンの箱と同じく、2 行の行では 1 行目に合わせる
            slotAlign,
            tone === "nav-active" ? "text-on-accent" : "text-warn",
          )}
        >
          {trailing}
        </span>
      ) : null}
    </button>
  );
}
