import { cn } from "../../lib/cn";
import { formatReadLineRange, skillLoadSummary, type SkillBadge, type SkillBadgeState } from "../../lib/skillLoad";
import { DisclosureChevronIcon } from "../icons";

// 3 件まではそのまま並べる。4 件目からは +N へ畳み、バッジ行が本文を押し下げないようにする
const MAX_VISIBLE_BADGES = 3;

// 実行中は成功 (既定) / 失敗と別の中間状態。位相ラベルと同じくアクセント色で表す
const STATE_CLASS: Record<SkillBadgeState, string> = {
  done: "border-line/70",
  running: "border-accent/40 text-accent-text",
  failed: "border-danger/50 text-danger-text",
};

/** 色だけでは状態が伝わらないため、hover と読み上げの補いを title に持たせる (名前は可視のまま) */
const STATE_TITLE: Record<SkillBadgeState, string> = {
  done: "",
  running: "読み込み中",
  failed: "読み込み失敗",
};

/**
 * assistant バブル上部のスキル読み込みバッジ。既定は `[skill] <name>[:start-end]` だけを見せ、
 * 展開で解決後のパス・行範囲・失敗理由 (1行) を確認できる。本文は設定画面で読めるため出さない。
 */
function SkillBadgeItem({ badge, compact }: { badge: SkillBadge; compact: boolean }) {
  const load = badge.load;
  const range = formatReadLineRange(load.offset, load.limit);
  // 履歴だけの失敗は理由を持たない (DTO に理由が無く、復元もできない)
  const reason = badge.state === "failed" ? (badge.reason ?? "読み込み失敗") : undefined;
  return (
    <details className={cn("min-w-0 rounded-lg border bg-soft/20 transition-colors", STATE_CLASS[badge.state])}>
      <summary
        title={STATE_TITLE[badge.state] || undefined}
        className="disclosure-summary flex min-w-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-0.5 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <DisclosureChevronIcon />
        <span className="min-w-0 truncate">{skillLoadSummary(load)}</span>
      </summary>
      <div className={cn("grid gap-1.5 border-t border-line/70 py-2 pr-2 text-ink-muted", compact ? "pl-3" : "pl-6")}>
        <div className="grid min-w-0 gap-0.5">
          <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">パス</span>
          <code className="break-words whitespace-pre-wrap">{load.path}</code>
        </div>
        {range ? (
          <div className="grid min-w-0 gap-0.5">
            <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">行範囲</span>
            <code>{range.slice(1)}</code>
          </div>
        ) : null}
        {badge.state === "running" ? <div className="text-accent-text">読み込み中…</div> : null}
        {reason ? (
          <div className="grid min-w-0 gap-0.5">
            <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">失敗理由</span>
            <code className="break-words whitespace-pre-wrap">{reason}</code>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** 畳んだ分の展開。中身は同じバッジなので、それぞれの展開で詳細を確認できる */
function FoldedBadges({ badges, compact }: { badges: SkillBadge[]; compact: boolean }) {
  return (
    <details className="min-w-0 rounded-lg border border-line/70 bg-soft/20 text-ink-faint transition-colors">
      <summary
        title={`残り ${badges.length} 件を表示`}
        className="disclosure-summary flex cursor-pointer items-center gap-1 rounded-lg px-2 py-0.5 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
      >
        <DisclosureChevronIcon />
        <span>+{badges.length}</span>
      </summary>
      <ul className="m-0 grid list-none gap-1.5 border-t border-line/70 p-2 text-ink-muted">
        {badges.map((badge) => (
          <li key={badge.load.id} className="min-w-0">
            <SkillBadgeItem badge={badge} compact={compact} />
          </li>
        ))}
      </ul>
    </details>
  );
}

export function SkillLoadList({ badges, compact }: { badges: SkillBadge[]; compact: boolean }) {
  if (badges.length === 0) return null;
  const folded = badges.slice(MAX_VISIBLE_BADGES);
  return (
    <ul
      className={cn(
        "m-0 flex list-none flex-wrap items-start gap-1.5 font-mono text-2xs text-ink-muted",
        compact ? "mb-1.5" : "mb-2.5",
      )}
    >
      {badges.slice(0, MAX_VISIBLE_BADGES).map((badge) => (
        <li key={badge.load.id} className="min-w-0">
          <SkillBadgeItem badge={badge} compact={compact} />
        </li>
      ))}
      {folded.length > 0 ? (
        <li className="min-w-0">
          <FoldedBadges badges={folded} compact={compact} />
        </li>
      ) : null}
    </ul>
  );
}
