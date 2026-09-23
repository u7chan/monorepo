import { cn } from "../../lib/cn";
import { skillLocationLabel } from "../../lib/sessionSkills";
import type { SkillBlock } from "../../lib/skillBlock";
import { DisclosureChevronIcon } from "../icons";

/**
 * user バブルのスキル展開ブロック。`/skill:` の本文は長いので畳んでおき、名前と場所だけを常に見せる
 * (何がモデルへ渡ったかを後から追えるようにする)。引数は MessageView が本文として別に描く。
 */
export function SkillInvocation({ block, rootCwd, compact }: { block: SkillBlock; rootCwd: string; compact: boolean }) {
  return (
    <div
      className={cn(
        "mb-1.5 rounded-2xl rounded-tr-md border border-accent/25 bg-accent-wash text-2xs text-ink-soft",
        compact ? "px-3 py-2" : "px-3.5 py-2.5",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-sans text-3xs tracking-wide text-accent-text uppercase">スキル</span>
        <span className="min-w-0 truncate font-medium text-ink-strong">{block.name}</span>
        <span className="ml-auto min-w-0 truncate font-sans text-3xs text-ink-faint" title={block.location}>
          {skillLocationLabel(rootCwd, block.location)}
        </span>
      </div>
      <details className="mt-1 min-w-0">
        <summary className="disclosure-summary flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
          <DisclosureChevronIcon />
          <span>送信した本文</span>
        </summary>
        <pre className="mt-1 max-h-60 min-w-0 scrollbar-thin overflow-auto rounded-md bg-soft/40 p-2 font-mono text-3xs break-words whitespace-pre-wrap text-ink-muted">
          {block.content}
        </pre>
      </details>
    </div>
  );
}
