import type { PromptDef } from "../../types";
import { filterBySearch } from "../../lib/settingsSearch";
import { PROMPT_LIST_EMPTY_NOTE } from "../../lib/promptSettings";
import { DefinitionList } from "../DefinitionList";
import { MenuItem } from "../MenuItem";
import { PlusIcon } from "../icons";
import { useState } from "react";
import { SettingsSearchField } from "../SettingsSearchField";

export const PROMPT_LIST_SEARCH_PLACEHOLDER = "定型プロンプトを検索";
export const PROMPT_LIST_SEARCH_ARIA_LABEL = "定型プロンプトを検索";

/**
 * マスタの一覧。組み込みと自作を同じリストに並べ、行の状態で区別する (見出しを分けると、
 * 同じ検索語で片方だけが出て「無い」と読める)。選択は行のクリックで、追加はフッター。
 */
export function PromptList({
  prompts,
  editingId,
  onSelect,
  onStartNew,
}: {
  prompts: PromptDef[];
  editingId: string | null;
  onSelect: (promptId: string) => void;
  onStartNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = filterBySearch(prompts, query, (prompt) => [prompt.label, prompt.prompt]);

  return (
    <DefinitionList
      title="定型プロンプト一覧"
      count={prompts.length}
      search={
        <SettingsSearchField
          value={query}
          onChange={setQuery}
          placeholder={PROMPT_LIST_SEARCH_PLACEHOLDER}
          ariaLabel={PROMPT_LIST_SEARCH_ARIA_LABEL}
        />
      }
      footer={
        <button
          type="button"
          onClick={onStartNew}
          className="flex min-h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-3 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
        >
          <PlusIcon />
          新しい定型プロンプト
        </button>
      }
      // 1 件も無いときは、全件 0 件でも検索外れでも空状態を出す (未絞込の count では判定しない)
      emptyLabel={visible.length === 0 ? PROMPT_LIST_EMPTY_NOTE : undefined}
    >
      <div className="grid min-w-0 content-start gap-1">
        {visible.map((prompt) => {
          const status =
            prompt.kind === "builtin"
              ? { text: "組み込み", tone: "muted" as const }
              : prompt.usedBy.length > 0
                ? { text: `使用中 ${prompt.usedBy.length}`, tone: "accent" as const }
                : { text: "未使用", tone: "muted" as const };
          return (
            <div key={prompt.id} data-prompt-row={prompt.id} className="flex min-w-0 items-stretch gap-1">
              <div className="min-w-0 flex-1">
                <MenuItem
                  label={prompt.label}
                  description={prompt.prompt}
                  status={status}
                  selected={editingId === prompt.id}
                  onClick={() => onSelect(prompt.id)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </DefinitionList>
  );
}
