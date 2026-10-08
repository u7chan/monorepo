import type { ReactNode } from "react";
import { DisclosureChevronIcon } from "./icons";

export type CollapsibleNoticeProps = {
  /** 畳んだときに出す 1 行。展開しなくても要点が読める文言にする */
  summary: ReactNode;
  children: ReactNode;
};

/**
 * 常時出す注意書きを既定で畳む箱。開閉の高さは既存の details::details-content が持ち、
 * 対応していないブラウザーでは瞬時に開閉する (docs/frontend.md#折りたたみ)。
 */
export function CollapsibleNotice({ summary, children }: CollapsibleNoticeProps) {
  return (
    <details className="overflow-hidden rounded-lg border border-warn/40 bg-raised text-2xs leading-relaxed text-warn">
      <summary className="disclosure-summary flex cursor-pointer items-start gap-1.5 px-2.5 py-2 transition-colors outline-none hover:bg-warn/10 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
        <span className="mt-0.5">
          <DisclosureChevronIcon />
        </span>
        <span className="min-w-0 flex-1 break-words">{summary}</span>
      </summary>
      <div className="grid gap-1 px-2.5 pb-2">{children}</div>
    </details>
  );
}
