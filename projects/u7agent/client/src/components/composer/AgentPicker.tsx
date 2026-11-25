import { useId } from "react";
import { AGENT_PICKER_MARGIN } from "../../lib/agentPicker";
import { cn } from "../../lib/cn";
import { useAgentPickerPopover } from "../../hooks/useAgentPickerPopover";
import { usePopoverShell } from "../../hooks/usePopoverShell";
import type { AgentDef } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { MenuItem } from "../MenuItem";
import { agentBoxClass, agentFrameClass } from "./fieldStyles";

/**
 * コンポーザーのエージェント選択。native `<select>` の `<option>` には画像を描画できないため、
 * button + native `popover="auto"` の listbox で行にアイコンと名前を出す。外側クリックと Escape の
 * 終了は標準の light dismiss に任せ、自前で閉じる経路（選択 / Tab での退出）だけ `hidePopover()` を通す。
 * 本体は常時 mount する（React の条件付き mount で出し入れすると標準の開閉と二重管理になる）。
 */
export function AgentPicker({
  agents,
  agentId,
  singleColumn,
  onChangeAgent,
}: {
  agents: AgentDef[];
  agentId: string;
  singleColumn: boolean;
  onChangeAgent: (agentId: string) => void;
}) {
  const pickerId = useId();
  const triggerId = `${pickerId}-trigger`;
  const selected = agents.find((agent) => agent.id === agentId);
  const selectedIndex = agents.findIndex((agent) => agent.id === agentId);

  const { listRef, size: sizePicker, place } = useAgentPickerPopover();

  // ツリーのスクロールでも閉じずトリガーへ追随させ、焦点が外れたら閉じる (この画面の殻の使い方)。
  // 開いた直後は選択中の行へ入る (native select と同じ)
  const picker = usePopoverShell(place, AGENT_PICKER_MARGIN, {
    reposition: ({ place: placeNow }) => placeNow(),
    exitOnBlur: ({ close }) => close(),
    size: sizePicker,
    openOnArrowKeys: true,
    openFocus: (items) => items[Math.min(Math.max(selectedIndex, 0), items.length - 1)] ?? null,
  });

  const selectAgent = (next: string) => {
    if (next !== agentId) onChangeAgent(next);
    // フォーカスは外さない: blur すると native の復帰が起きず、トリガーへ戻らない
    picker.close();
  };

  return (
    <>
      <span className={agentFrameClass(singleColumn)}>
        <button
          type="button"
          {...picker.triggerProps}
          id={triggerId}
          aria-haspopup="listbox"
          aria-controls={pickerId}
          aria-label={selected === undefined ? "エージェントを選択" : `エージェントを選択（${selected.name}）`}
          popoverTarget={pickerId}
          popoverTargetAction="toggle"
          disabled={agents.length === 0}
          className={cn(
            "peer cursor-pointer disabled:cursor-not-allowed disabled:opacity-55",
            agentBoxClass(singleColumn),
          )}
        >
          {/* 不可視の sizer を全候補ぶん同じセルに重ね、実際の描画幅の最大値を欄の幅にする。文字数では
              幅の広い名前を取りこぼし、選択のたびに欄と chevron が動く (選択で幅を動かさない) */}
          {agents.map((agent) => (
            <span key={agent.id} aria-hidden="true" className="invisible col-start-1 row-start-1 truncate">
              {agent.name}
            </span>
          ))}
          <span className="col-start-1 row-start-1 min-w-0 truncate">{selected?.name ?? ""}</span>
        </button>
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center peer-disabled:opacity-55">
          <AgentIcon icon={selected?.icon} variant="inline" />
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-2.5 size-3 shrink-0 text-ink-faint peer-disabled:opacity-55"
        >
          <path d="M4 6.75 8 10.75 12 6.75" />
        </svg>
      </span>
      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置と幅は place() が left / top / min-width / max-width を直接書く */}
      <div
        {...picker.popoverProps}
        {...picker.exitProps}
        id={pickerId}
        popover="auto"
        role="listbox"
        aria-labelledby={triggerId}
        className="popover-panel fixed inset-auto m-0 w-max overflow-visible rounded-lg border border-line bg-panel p-1 shadow-panel singleColumn:p-2"
      >
        <div ref={listRef} className="scrollbar-thin overflow-y-auto">
          {agents.map((agent, index) => (
            <MenuItem
              key={agent.id}
              ref={picker.itemRef(index)}
              role="option"
              tabIndex={-1}
              icon={<AgentIcon icon={agent.icon} variant="list" />}
              label={agent.name}
              selected={agent.id === agentId}
              onClick={() => selectAgent(agent.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}
