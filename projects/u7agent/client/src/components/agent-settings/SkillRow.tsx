import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * スキル 1 行の見た目。`control` を渡すと操作できる行 (label 全体がヒット領域)、渡さないと読み取り専用の行になる
 * (ビルトインの閲覧ビューも編集フォームと同じ行で見せる)。
 */
export function SkillRow({
  name,
  description,
  control,
  badge,
  hint,
}: {
  name: string;
  description: string;
  /** チェックボックスなど。無い行は読み取り専用になる */
  control?: ReactNode;
  /** 名前の右に出す補足 (「自動起動なし」/ 同梱物の版) */
  badge?: string;
  /** 説明の下に出す補足 (外した行の注記など) */
  hint?: string;
}) {
  const row = (
    <>
      {control}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs text-ink">{name}</span>
          {badge ? <span className="shrink-0 text-2xs leading-4 text-ink-ghost">{badge}</span> : null}
        </span>
        {/* 説明の全文は「スキル」ページにあるので、ここは 1 行に切って title へ逃がす */}
        <small className="block truncate text-2xs text-ink-muted" title={description}>
          {description}
        </small>
        {hint ? <small className="block text-2xs text-ink-faint">{hint}</small> : null}
      </span>
    </>
  );
  // min-w-0: 説明を truncate すると行の min-content が説明の全幅になり、一覧の行が箱より広がる
  const rowClassName = "flex min-w-0 items-start gap-2 rounded-lg bg-raised px-2.5 py-1.5";
  return control ? (
    <label className={cn(rowClassName, "cursor-pointer")}>{row}</label>
  ) : (
    <div className={rowClassName}>{row}</div>
  );
}

/**
 * スキルのグループ。見出しは「名前 + 件数」で、右端の `actions` に編集フォームの導線
 * (すべて外す / 使用に戻す) を置く。`divider` は前のグループとの境目を出すかどうか。
 */
export function SkillGroup({
  label,
  countText,
  actions,
  divider = false,
  children,
}: {
  label: string;
  /** 見出しの右に出す件数 (「使用 2 / 全 3」など) */
  countText: string;
  actions?: ReactNode;
  divider?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid gap-1", divider && "border-t border-line pt-2")}>
      <div className="flex items-baseline justify-between gap-2 text-2xs font-semibold tracking-label text-ink-faint uppercase">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{label}</span>
          <span className="shrink-0 font-normal">{countText}</span>
        </span>
        {actions ? (
          <span className="flex shrink-0 items-baseline gap-2.5 font-normal tracking-normal">{actions}</span>
        ) : null}
      </div>
      <div className="max-h-72 scrollbar-thin overflow-x-hidden overflow-y-auto">
        <div className="grid gap-1">{children}</div>
      </div>
    </div>
  );
}
