import type { ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** select の密度。余白と文字サイズはこの表が持ち、呼び出し側は layout だけを渡す */
export type SelectFieldDensity = "sm" | "md" | "lg";

/** md は .field の既定の余白 (px-2.5 py-2) をそのまま使う。leadingIcon の分だけ左を広げる */
const PADDING_CLASS: Record<SelectFieldDensity, { plain: string; leading: string }> = {
  sm: { plain: cn("py-1 pl-1.5"), leading: cn("py-1 pl-6.5") },
  md: { plain: "", leading: cn("pl-6.5") },
  lg: { plain: cn("py-1.5 pl-2"), leading: cn("py-1.5 pl-7") },
};

const TEXT_CLASS: Record<SelectFieldDensity, string> = {
  sm: "text-1xs",
  md: "text-xs",
  lg: "text-xs",
};

export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  /** touch 端末では iOS の focus 時ズームを避けるため 16px にする */
  compact?: boolean;
  density?: SelectFieldDensity;
  /** select の左に置く印 (選択中エージェントのアイコンなど)。左の余白はこの表が持つ */
  leadingIcon?: ReactNode;
  /** chevron を右端に合わせるため wrapper 側に置く */
  wrapperClassName?: string;
  children: ReactNode;
};

/**
 * select のドロップダウン矢印はブラウザが位置を決めるため右端に寄りすぎる。矢印だけ自前の chevron に
 * 置き換えて余白を揃える。幅と伸縮は wrapper が担い、select は w-full で wrapper に追従する。
 * 見た目は density と compact が持ち、className は layout (位置・幅) のためだけに開けている。
 */
export function SelectField({
  wrapperClassName,
  className,
  compact = false,
  density = "md",
  leadingIcon,
  children,
  ...props
}: SelectFieldProps) {
  return (
    <span className={cn("relative inline-flex min-w-0 items-center", wrapperClassName)}>
      <select
        {...props}
        className={cn(
          "field peer w-full cursor-pointer appearance-none pr-8 disabled:cursor-not-allowed disabled:opacity-55",
          leadingIcon ? PADDING_CLASS[density].leading : PADDING_CLASS[density].plain,
          compact ? "text-md" : TEXT_CLASS[density],
          className,
        )}
      >
        {children}
      </select>
      {leadingIcon ? (
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center peer-disabled:opacity-55">
          {leadingIcon}
        </span>
      ) : null}
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
