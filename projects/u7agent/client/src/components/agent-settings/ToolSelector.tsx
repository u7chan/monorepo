import { useState } from "react";
import { allowlistCount, allowlistCountLabel } from "../../lib/agentAllowlist";
import {
  ALLOWLIST_DEFAULT_LABEL,
  ALLOWLIST_DIRTY_LABEL,
  ALLOWLIST_DISABLE_GROUP_LABEL,
  ALLOWLIST_RESET_LABEL,
  ALLOWLIST_SEARCH_EMPTY_NOTE,
} from "../../lib/allowlistText";
import {
  TOOL_CARD_NOTE,
  TOOL_CATALOG_UNAVAILABLE_NOTE,
  TOOL_EXPLICIT_NOTE,
  TOOL_GROUP_LABELS,
  groupTools,
  missingToolNote,
  offToolNote,
  unavailableToolNote,
} from "../../lib/tools";
import { filterBySearch } from "../../lib/settingsSearch";
import type { ToolCatalogEntry, ToolGroup } from "../../types";
import { SettingsSearchField } from "../SettingsSearchField";
import { SkillGroup } from "./SkillRow";
import { SwitchRow } from "./SwitchRow";

export const TOOL_PANEL_HEADING = "ツール";
export const TOOL_SEARCH_PLACEHOLDER = "ツール名・説明で絞り込む";
export const TOOL_SEARCH_ARIA_LABEL = "ツールを絞り込む";

/** 行の ON / OFF。未指定 / 解除は全部 ON、明示リストは配列に含まれる名前だけ ON */
function usedName(names: string[] | null | undefined, visible: readonly string[], name: string): boolean {
  if (!Array.isArray(names)) return visible.includes(name);
  return names.includes(name);
}

/**
 * エージェント編集のツールタブ。スキルと同じ 1 枚のパネルにグループ見出しとスイッチ行を積む。
 * 行は常に全部出し、アプリ側で使えない行には理由、外した行には依存の注記を出す
 * (行を消すと「外した」のか「そもそも無い」のかが読めなくなる)。検索は表示だけを絞る。
 */
export function ToolSelector({
  tools,
  toolNames,
  onToggleTool,
  onDisableToolGroup,
  onResetTools,
}: {
  /** カタログ応答のツール一覧。空は「取得できていない」を表す */
  tools: ToolCatalogEntry[];
  /** undefined = 未指定 (全部 ON)、null = 解除 (全部 ON)、配列 = 明示リスト ([] はすべて OFF) */
  toolNames?: string[] | null;
  onToggleTool: (name: string, checked: boolean) => void;
  /** グループ単位の「すべて外す」。対象はそのグループの未絞込 visible 行 */
  onDisableToolGroup: (group: ToolGroup) => void;
  onResetTools: () => void;
}) {
  const [query, setQuery] = useState("");
  const visibleNames = tools.map((tool) => tool.name);
  const count = allowlistCount(toolNames, visibleNames);
  const explicit = Array.isArray(toolNames);
  const groups = groupTools(tools);
  const missingNames = explicit ? toolNames.filter((name) => !visibleNames.includes(name)) : [];

  return (
    <div className="grid min-w-0 content-start gap-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-2xs text-ink-muted">
          <span className="font-semibold text-ink">
            使用 {count.used} / 全 {count.total}
          </span>
          <span className="text-ink-faint">{explicit ? ALLOWLIST_DIRTY_LABEL : ALLOWLIST_DEFAULT_LABEL}</span>
        </span>
        {explicit ? (
          <button type="button" className="link-quiet shrink-0" onClick={onResetTools}>
            {ALLOWLIST_RESET_LABEL}
          </button>
        ) : null}
      </div>
      <SettingsSearchField
        value={query}
        onChange={setQuery}
        placeholder={TOOL_SEARCH_PLACEHOLDER}
        ariaLabel={TOOL_SEARCH_ARIA_LABEL}
      />
      <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
        {tools.length === 0 ? (
          <p className="text-2xs leading-4 break-words text-warn">{TOOL_CATALOG_UNAVAILABLE_NOTE}</p>
        ) : (
          groups.map((entry, index) => {
            const groupNames = entry.tools.map((tool) => tool.name);
            const groupCount = allowlistCount(toolNames, groupNames);
            const rows = filterBySearch(entry.tools, query, (tool) => [tool.name, tool.description]);
            return (
              <SkillGroup
                key={entry.group}
                divider={index > 0}
                label={TOOL_GROUP_LABELS[entry.group]}
                countText={allowlistCountLabel(groupCount)}
                actions={
                  groupCount.used > 0 ? (
                    <button type="button" className="link-quiet" onClick={() => onDisableToolGroup(entry.group)}>
                      {ALLOWLIST_DISABLE_GROUP_LABEL}
                    </button>
                  ) : undefined
                }
              >
                {rows.length === 0 ? (
                  <p className="px-2.5 text-2xs leading-4 text-ink-faint">{ALLOWLIST_SEARCH_EMPTY_NOTE}</p>
                ) : (
                  rows.map((tool) => {
                    const notes = [
                      unavailableToolNote(tool.reason),
                      usedName(toolNames, visibleNames, tool.name) ? undefined : offToolNote(tool.name),
                    ].filter((note): note is string => Boolean(note));
                    return (
                      <SwitchRow
                        key={tool.name}
                        name={tool.name}
                        description={tool.description}
                        monoName
                        checked={usedName(toolNames, visibleNames, tool.name)}
                        onToggle={(checked) => onToggleTool(tool.name, checked)}
                        // 使えない理由と外したときの依存を両方出す (片方だけだと状態を取り違える)
                        hint={notes.length > 0 ? notes.join(" ") : undefined}
                      />
                    );
                  })
                )}
              </SkillGroup>
            );
          })
        )}
        {missingNames.length > 0 ? (
          <p className="text-2xs leading-4 break-words text-ink-faint">{missingToolNote(missingNames)}</p>
        ) : null}
        <div className="grid gap-1 border-t border-line pt-2">
          <p className="text-2xs leading-4 break-words text-ink-faint">{TOOL_CARD_NOTE}</p>
          {explicit ? <p className="text-2xs leading-4 break-words text-ink-faint">{TOOL_EXPLICIT_NOTE}</p> : null}
        </div>
      </div>
    </div>
  );
}
