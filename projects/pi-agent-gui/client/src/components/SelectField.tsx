import type { ReactNode, SelectHTMLAttributes } from "react";

export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  /** 選択欄の幅・伸縮・余白 (chevron を選択欄の右端に合わせるため wrapper 側に置く) */
  wrapperClassName?: string;
  children: ReactNode;
};

/**
 * select のドロップダウン矢印はブラウザが位置を決めるため右端に寄りすぎる。矢印だけ自前の chevron に
 * 置き換えて余白を揃える。幅と伸縮は wrapper が担い、select は w-full で wrapper に追従する。
 */
export function SelectField({ wrapperClassName, className, children, ...props }: SelectFieldProps) {
  return (
    <span className={["relative inline-flex min-w-0 items-center", wrapperClassName].filter(Boolean).join(" ")}>
      {/* peer を付けるのは、無効化したときの薄表示を chevron にも効かせるため */}
      <select
        {...props}
        className={["field peer w-full cursor-pointer appearance-none pr-8", className].filter(Boolean).join(" ")}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-2.5 size-3 shrink-0 text-ink-faint peer-disabled:opacity-55"
      >
        <path d="M4 6.75 8 10.75 12 6.75" />
      </svg>
    </span>
  );
}
