import { useRef, useState } from "react";
import type { PromptDef } from "../../types";
import { useAgentDrag, type AgentDragNaming } from "../../hooks/useAgentDrag";
import { cn } from "../../lib/cn";
import { filterBySearch } from "../../lib/settingsSearch";
import { PROMPT_LIST_EMPTY_NOTE } from "../../lib/promptSettings";
import { DefinitionList } from "../DefinitionList";
import { MenuItem } from "../MenuItem";
import { GripIcon, PlusIcon } from "../icons";
import { SettingsSearchField } from "../SettingsSearchField";

export const PROMPT_LIST_SEARCH_PLACEHOLDER = "定型プロンプトを検索";
export const PROMPT_LIST_SEARCH_ARIA_LABEL = "定型プロンプトを検索";

/** 一覧ごとに変える名前。styles/index.css の `.prompt-drag-row` / `body.is-dragging-prompt` と揃える */
const PROMPT_DRAG_NAMING: AgentDragNaming = {
  rowAttribute: "data-prompt-row",
  yVariable: "--prompt-drag-y",
  bodyClass: "is-dragging-prompt",
};

/**
 * マスタの一覧。組み込みと自作を同じリストに並べ、行の状態で区別する (見出しを分けると、
 * 同じ検索語で片方だけが出て「無い」と読める)。選択は行のクリックで、追加はフッター。
 * 並べ替えは自作だけで、組み込みは先頭固定でグリップを出さない (docs/api-catalog.md)。
 */
export function PromptList({
  prompts,
  reorderIds,
  editingId,
  onSelect,
  onStartNew,
  onReorder,
  onCommitOrder,
  onCancelOrder,
  reorderDisabled = false,
}: {
  prompts: PromptDef[];
  /** グリップで動かせる行の id（表示順）。組み込みは含めない */
  reorderIds: readonly string[];
  editingId: string | null;
  onSelect: (promptId: string) => void;
  onStartNew: () => void;
  /** ドラッグ中の live 差し替え */
  onReorder: (ids: string[]) => void;
  /** 移動があったときの確定 */
  onCommitOrder: () => void;
  /** 取り消し */
  onCancelOrder: () => void;
  /** 保存中は新しいドラッグを開始させない */
  reorderDisabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  // 検索中は並べ替えを開かない: 非表示の行との順序を決められず、確定すると見えていない行まで動く
  const dragDisabled = reorderDisabled || searching;
  const drag = useAgentDrag({
    containerRef,
    naming: PROMPT_DRAG_NAMING,
    ids: reorderIds,
    onMove: onReorder,
    onCommit: onCommitOrder,
    onCancel: onCancelOrder,
    disabled: dragDisabled,
  });
  const reorderable = new Set(searching ? [] : reorderIds);
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
      <div ref={containerRef} className="grid min-w-0 content-start gap-1" {...drag.containerHandlers}>
        {visible.map((prompt) => {
          const status =
            prompt.kind === "builtin"
              ? { text: "組み込み", tone: "muted" as const }
              : prompt.usedBy.length > 0
                ? { text: `使用中 ${prompt.usedBy.length}`, tone: "accent" as const }
                : { text: "未使用", tone: "muted" as const };
          return (
            <div
              key={prompt.id}
              data-prompt-row={prompt.id}
              className={cn("flex min-w-0 items-stretch gap-1", drag.draggingId === prompt.id && "prompt-drag-row")}
            >
              <div className="min-w-0 flex-1">
                <MenuItem
                  label={prompt.label}
                  description={prompt.prompt}
                  status={status}
                  selected={editingId === prompt.id}
                  onClick={() => onSelect(prompt.id)}
                />
              </div>
              {reorderable.has(prompt.id) ? (
                // グリップは行の button の外に置く（中に入れるとクリックが選択として伝播する）
                <button
                  type="button"
                  aria-label={`${prompt.label}の順番を変更`}
                  className="drag-grip"
                  {...drag.gripHandlers(prompt.id)}
                >
                  <GripIcon />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </DefinitionList>
  );
}
