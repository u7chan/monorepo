import type { UsageSource } from "../api";
import { showsWindows } from "./status";
import { findBlockedWindows } from "./windows";

/**
 * どの窓も使えないカードか。外側の窓が尽きて内側が止まっている場合も、使えないことに変わりはない。
 * 窓が無い（取得前・取得失敗）カードは、使えるか分からないので対象外にする。
 */
export function isExhausted(source: UsageSource): boolean {
  if (!showsWindows(source.state) || source.windows.length === 0) {
    return false;
  }

  const blocked = findBlockedWindows(source.windows);

  return source.windows.every((window) => window.usedPercent >= 100 || blocked.has(window.id));
}

/**
 * 使えるカードを先に、使い切ったカードを末尾に置く。それ以外の並びは与えられた順のまま。
 * 使い切ったカードはリセット待ちなだけなので、消さずに下へ回す。
 */
export function orderSources(sources: readonly UsageSource[]): UsageSource[] {
  const usable: UsageSource[] = [];
  const exhausted: UsageSource[] = [];

  for (const source of sources) {
    (isExhausted(source) ? exhausted : usable).push(source);
  }

  return [...usable, ...exhausted];
}
