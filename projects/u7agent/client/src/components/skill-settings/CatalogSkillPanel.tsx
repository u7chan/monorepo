import type { AgentDef, SkillDef } from "../../types";
import { PencilIcon } from "../icons";
import { SkillDetailPanel } from "./SkillDetailPanel";

/** 割り当て中は 0 件でも件数を出す (誰も使っていないことが分かるようにする) */
function assignedLabel(agents: AgentDef[]): string {
  if (agents.length === 0) return "0 件";
  return `${agents.length} 件（${agents.map((agent) => agent.name).join("、")}）`;
}

/**
 * カタログスキル (GUI で作る編集可能なスキル) の閲覧ビュー。一覧で選んだ直後に出すのは保存済みの内容で、
 * 編集は操作行の `編集` から始める (docs/api-catalog.md)。本文はカタログの応答をそのまま出す。
 */
export function CatalogSkillPanel({
  skill,
  agents,
  variant,
  onEdit,
}: {
  skill: SkillDef;
  /** 割り当て中の表示に使う (skillIds にこのスキルを含むエージェント) */
  agents: AgentDef[];
  variant: "page" | "sheet";
  onEdit: () => void;
}) {
  return (
    <SkillDetailPanel
      heading={variant === "page" ? "スキル" : null}
      actions={
        <button type="button" onClick={onEdit} className="btn-quiet">
          <PencilIcon />
          編集
        </button>
      }
      meta={[
        { label: "名前", value: skill.name, tone: "strong" },
        { label: "説明", value: skill.description || "説明なし" },
        { label: "割り当て中", value: assignedLabel(agents.filter((agent) => agent.skillIds.includes(skill.id))) },
      ]}
      body={{ status: "ready", text: skill.body }}
    />
  );
}
