// SegmentedControl - 排他的な選択肢を並べ、選択を示すつまみが動いて移るコントロール
//
// 部品はネイティブの radio を使う。矢印キーでの移動と、読み上げでの「3 つ中 2 つ目」が
// 追加の ARIA なしで揃うため。button + aria-pressed の並びは、排他であることが伝わらない。

import { useId, type CSSProperties, type ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  /** 画面に出す中身。アイコンだけのときは ariaLabel も渡す */
  label: ReactNode;
  ariaLabel?: string;
}

interface SegmentedControlProps<T extends string> {
  /** グループ全体の名前 (読み上げ用) */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 幅などの配置 */
  className?: string;
  /** 面の上に置く標準の見た目。ガラスの上など別の面に置くときだけ差し替える */
  trackClassName?: string;
  thumbClassName?: string;
  segmentClassName?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className = "",
  trackClassName = "rounded-control bg-fill",
  thumbClassName = "rounded-[0.625rem] bg-thumb shadow-thumb",
  segmentClassName = "px-3",
}: SegmentedControlProps<T>) {
  const name = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ "--n": options.length, "--i": selectedIndex } as CSSProperties}
      className={[
        "relative grid auto-cols-[minmax(0,1fr)] grid-flow-col p-0.5",
        trackClassName,
        className,
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "absolute inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/var(--n))] translate-x-[calc(var(--i)*100%)]",
          "transition-transform duration-300 ease-ios",
          thumbClassName,
        ].join(" ")}
      />
      {options.map((option) => (
        <label
          key={option.value}
          className={[
            "hit-area relative z-10 grid min-h-8 cursor-pointer place-items-center rounded-[inherit]",
            "text-control font-medium text-label-2 transition-colors duration-200",
            "can-hover:hover:text-label has-[:checked]:text-label has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-0",
            "has-[:focus-visible]:outline-accent",
            segmentClassName,
          ].join(" ")}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
            aria-label={option.ariaLabel}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export default SegmentedControl;
