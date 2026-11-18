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
 * 月次の残り。月次は一番外側の窓で、尽きたら内側が残っていても使えないため、並びの基準にする。
 * 月次を持たない Codex と、月次を読めないカードは `null`。
 */
function monthlyRemainingPercent(source: UsageSource): number | null {
  if (source.provider !== "opencode-go" || !showsWindows(source.state)) {
    return null;
  }

  const monthly = source.windows.find((window) => window.label.startsWith("月次"));

  return monthly ? 100 - monthly.usedPercent : null;
}

/**
 * 月次を読めたカードだけを、その残りが多い順に置き直す。Codex や月次を読めないカードは元の位置に残す。
 * 読めない残りを 0 や 100 とみなすと、確かめていない順位で上に出してしまう。
 */
function byMonthlyRemaining(sources: readonly UsageSource[]): UsageSource[] {
  const ranked = sources
    .map((source) => ({ source, remaining: monthlyRemainingPercent(source) }))
    .filter((entry): entry is { source: UsageSource; remaining: number } => entry.remaining !== null)
    .sort((a, b) => b.remaining - a.remaining);
  const ordered = new Set(ranked.map((entry) => entry.source));
  let next = 0;

  return sources.map((source) => {
    if (!ordered.has(source)) {
      return source;
    }

    const replacement = ranked[next]?.source ?? source;

    next += 1;

    return replacement;
  });
}

/**
 * 使えるカードを先に、使い切ったカードを末尾に置く。
 * 使える OpenCode Go のカードどうしは月次の残りが多い順、それ以外は与えられた順のまま。
 * 使い切ったカードはリセット待ちなだけなので、消さずに下へ回す。
 */
export function orderSources(sources: readonly UsageSource[]): UsageSource[] {
  const usable: UsageSource[] = [];
  const exhausted: UsageSource[] = [];

  for (const source of sources) {
    (isExhausted(source) ? exhausted : usable).push(source);
  }

  return [...byMonthlyRemaining(usable), ...exhausted];
}
