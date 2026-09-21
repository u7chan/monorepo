import type { FileSkillsState } from "../../hooks/useFileSkills";
import {
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_SCOPE_LABEL,
  fileSkillDuplicateWarning,
} from "../../lib/fileSkills";
import type { FileSkillInfo } from "../../types";
import { RefreshIcon } from "../icons";

export type FileSkillListProps = {
  state: FileSkillsState;
  onReload: () => void;
};

/**
 * 共通スキル (`.agents/skills`) の読み取り専用一覧。編集・削除・エージェント割り当ての操作は持たない。
 * 同名はサーバー側で優先順位により一意化済みで、影になった側を警告として出す (docs/api-catalog.md)。
 */
export function FileSkillList({ state, onReload }: FileSkillListProps) {
  return (
    <section className="mt-3 grid min-w-0 content-start gap-1 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <h3 className="min-w-0 truncate text-2xs font-semibold tracking-widest text-ink-faint uppercase">
          {FILE_SKILL_GROUP_LABEL}
        </h3>
        <button
          type="button"
          onClick={onReload}
          aria-label="共通スキルを再読み込み"
          className="btn-quiet shrink-0 px-1.5 py-0.5"
        >
          <RefreshIcon />
        </button>
      </div>
      {state.status === "loading" ? (
        <p className="px-2 text-2xs leading-4 text-ink-muted">{FILE_SKILL_LOADING_NOTE}</p>
      ) : null}
      {state.status === "error" ? (
        <p className="px-2 text-2xs leading-4 break-words text-warn">
          {FILE_SKILL_ERROR_PREFIX}: {state.message}
        </p>
      ) : null}
      {state.status === "ready" && state.skills.length === 0 ? (
        <p className="px-2 text-2xs leading-4 text-ink-muted">{FILE_SKILL_EMPTY_NOTE}</p>
      ) : null}
      {state.status === "ready" ? state.skills.map((skill) => <FileSkillRow key={skill.path} skill={skill} />) : null}
    </section>
  );
}

/** 行はボタンにしない (読み取り専用で、押しても何も起きない選択状態を作らない)。 */
function FileSkillRow({ skill }: { skill: FileSkillInfo }) {
  const warning = fileSkillDuplicateWarning(skill);
  return (
    <div className="grid min-w-0 gap-1 rounded-lg px-2 py-1">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-xs leading-4 text-ink">{skill.name}</span>
        <span className="shrink-0 text-2xs leading-4 text-ink-ghost">{FILE_SKILL_SCOPE_LABEL[skill.scope]}</span>
        {skill.disableModelInvocation ? (
          <span className="shrink-0 text-2xs leading-4 text-ink-ghost">自動起動なし</span>
        ) : null}
      </div>
      <p className="truncate text-2xs leading-4 text-ink-soft">{skill.description || "説明なし"}</p>
      <code className="truncate text-2xs leading-4 text-ink-ghost">{skill.relativePath}</code>
      {warning ? <p className="text-2xs leading-4 break-words text-warn">{warning}</p> : null}
    </div>
  );
}
