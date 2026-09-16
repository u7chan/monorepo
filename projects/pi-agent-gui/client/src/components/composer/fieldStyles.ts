/** エージェント / Model / Effort の select で同じ見た目を共有する (片方だけ変わると行が揃わない) */

export const fieldLabelClass = (compact: boolean): string =>
  ["flex min-w-0 items-center text-2xs text-ink-faint", compact ? "gap-2" : "gap-1.5"].join(" ");

export const fieldNameClass = (compact: boolean): string =>
  compact ? "w-12 shrink-0 uppercase tracking-wide" : "shrink-0 uppercase tracking-wide";

// compact の入力欄は iOS Safari の focus 時ズームを避けるため 16px 以上にする
// (theme の色トークンが base なので Tailwind の text-base は使えない)
export const selectClass = (compact: boolean): string =>
  ["py-1 pl-1.5 disabled:cursor-not-allowed disabled:opacity-55", compact ? "text-md" : "text-1xs"].join(" ");

/** 余白と伸縮は wrapper 側に置く (select は chevron と重ならない右余白を SelectField が持つ) */
export const selectWrapperClass = (compact: boolean, maxWidth: string): string =>
  compact ? "min-w-0 flex-1" : `min-w-0 ${maxWidth}`;
