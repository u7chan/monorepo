import {
  TOOL_CARD_NOTE,
  TOOL_CATALOG_UNAVAILABLE_NOTE,
  TOOL_DISABLE_ALL_LABEL,
  TOOL_EXPLICIT_NOTE,
  TOOL_GROUP_LABELS,
  TOOL_SHOW_ALL_LABEL,
  groupTools,
  missingToolNote,
  offToolNote,
  unavailableToolNote,
} from "../../lib/tools";
import type { ToolCatalogEntry } from "../../types";
import { SkillGroup, SkillRow } from "./SkillRow";

/**
 * ツール欄 (エージェント定義の許可リスト)。スキル欄と同じく、行は常に全部出して、使えない行には
 * アプリ側の理由、外した行には依存の注記を出す。行を消すと「外した」のか「そもそも無い」のかが
 * 読めなくなるため (取得できていないときだけ行ではなく理由を出す)。
 */
export function ToolSelector({
  tools,
  toolNames,
  onToggleTool,
  onShowAllTools,
  onDisableAllTools,
}: {
  /** カタログ応答のツール一覧。空は「取得できていない」を表す */
  tools: ToolCatalogEntry[];
  /** undefined = 未指定 (全部 ON)、null = 解除 (全部 ON)、配列 = 明示リスト ([] はすべて OFF) */
  toolNames?: string[] | null;
  onToggleTool: (name: string, checked: boolean) => void;
  onShowAllTools: () => void;
  onDisableAllTools: () => void;
}) {
  // undefined (未指定) と null (解除) はどちらも全部 ON で、明示リスト ([] を含む) だけが「選んだ名前」
  const explicit = Array.isArray(toolNames);
  const visibleNames = tools.map((tool) => tool.name);
  const usedNames = explicit ? toolNames : visibleNames;
  const usedCount = tools.filter((tool) => usedNames.includes(tool.name)).length;
  const missingNames = explicit ? toolNames.filter((name) => !visibleNames.includes(name)) : [];

  return (
    <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
        <span>ツール</span>
        <span className="font-normal">
          使用 {usedCount} / 全 {tools.length}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2.5 font-normal tracking-normal">
          {/* すべて OFF のときは外す対象が無いので出さない */}
          {usedCount > 0 ? (
            <button type="button" className="text-accent-text underline underline-offset-2" onClick={onDisableAllTools}>
              {TOOL_DISABLE_ALL_LABEL}
            </button>
          ) : null}
          {explicit ? (
            <button type="button" className="text-accent-text underline underline-offset-2" onClick={onShowAllTools}>
              {TOOL_SHOW_ALL_LABEL}
            </button>
          ) : null}
        </span>
      </div>
      {tools.length === 0 ? (
        <p className="text-2xs leading-4 break-words text-warn">{TOOL_CATALOG_UNAVAILABLE_NOTE}</p>
      ) : (
        groupTools(tools).map((entry, index) => (
          <SkillGroup
            key={entry.group}
            divider={index > 0}
            label={TOOL_GROUP_LABELS[entry.group]}
            countText={`使用 ${entry.tools.filter((tool) => usedNames.includes(tool.name)).length} / 全 ${entry.tools.length}`}
          >
            {entry.tools.map((tool) => {
              const notes = [
                unavailableToolNote(tool.reason),
                usedNames.includes(tool.name) ? undefined : offToolNote(tool.name),
              ].filter((note): note is string => Boolean(note));
              return (
                <SkillRow
                  key={tool.name}
                  name={tool.name}
                  description={tool.description}
                  monoName
                  control={
                    <input
                      type="checkbox"
                      checked={usedNames.includes(tool.name)}
                      onChange={(event) => onToggleTool(tool.name, event.currentTarget.checked)}
                      className="mt-0.5 accent-focus"
                    />
                  }
                  // 使えない理由と外したときの依存を両方出す (片方だけだと状態を取り違える)
                  hint={notes.length > 0 ? notes.join(" ") : undefined}
                />
              );
            })}
          </SkillGroup>
        ))
      )}
      {missingNames.length > 0 ? (
        <p className="text-2xs leading-4 break-words text-ink-faint">{missingToolNote(missingNames)}</p>
      ) : null}
      <p className="text-2xs leading-4 break-words text-ink-faint">{TOOL_CARD_NOTE}</p>
      {explicit ? <p className="text-2xs leading-4 break-words text-ink-faint">{TOOL_EXPLICIT_NOTE}</p> : null}
    </div>
  );
}
