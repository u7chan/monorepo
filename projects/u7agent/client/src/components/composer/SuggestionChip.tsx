import { cn } from "../../lib/cn";
import type { AgentSuggestion } from "../../types";
import { CloseIcon } from "../icons";

export type SuggestionChipProps = {
  suggestion: AgentSuggestion;
  /** desktop は本文と同じ行、singleColumn は枠の中の上段 (狭い幅で本文が潰れるため行を分ける) */
  singleColumn: boolean;
  onClear: () => void;
};

/** 選択中の定型プロンプト。label は最大 60 字なので、幅の上限と省略表示で本文を押し出さない。 */
export function SuggestionChip({ suggestion, singleColumn, onClear }: SuggestionChipProps) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-lg border border-accent/40 bg-accent-wash text-accent-text",
        singleColumn
          ? "max-w-52 justify-self-start px-1 py-1.5 text-xs"
          : "mt-1 mr-2 mb-1 max-w-60 shrink-0 self-start px-2 py-1 text-2xs",
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        ◆
      </span>
      <span className="min-w-0 truncate" title={suggestion.label}>
        {suggestion.label}
      </span>
      <button
        type="button"
        aria-label={`${suggestion.label} を外す`}
        onClick={onClear}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-accent-text/70 transition-colors hover:bg-hover hover:text-ink"
      >
        <CloseIcon />
      </button>
    </span>
  );
}
