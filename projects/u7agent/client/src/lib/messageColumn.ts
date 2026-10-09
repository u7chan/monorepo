import { cn } from "./cn";

/** 非 compact の本文の可読幅。本文と同じ列に置く要素 (圧縮の区切り) も同じ幅に揃える */
export const MESSAGE_MEASURE_CLASS = "max-w-[min(760px,86%)]";

/**
 * 本文の左のアイコン列。実体は MessageView の flex の gap と AgentIcon bubble の寸法なので、
 * どちらかを変えるときはここも合わせる (compact は bubble が 1 段小さい)。
 */
const GUTTER_CLASS = { compact: "ml-7.5", normal: "ml-9.5" } as const;

/** メッセージ本文と同じ列。本文の外にある要素の左端と幅を、吹き出しの本文へ揃える */
export function messageColumnClass(compact: boolean): string {
  return cn(compact ? GUTTER_CLASS.compact : GUTTER_CLASS.normal, compact ? "" : MESSAGE_MEASURE_CLASS);
}
