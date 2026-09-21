import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { FileSkillsState } from "../../hooks/useFileSkills";
import {
  BUILTIN_SKILL_EMPTY_NOTE,
  BUILTIN_SKILL_GROUP_LABEL,
  BUILTIN_SKILL_OVERRIDE_NOTE,
  FILE_SKILL_EMPTY_NOTE,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_GROUP_LABEL,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_SCOPE_LABEL,
  fileSkillWarning,
  groupFileSkills,
} from "../../lib/fileSkills";
import type { FileSkillInfo } from "../../types";
import { RefreshIcon } from "../icons";

export type FileSkillListProps = {
  state: FileSkillsState;
  onReload: () => void;
  /** 選択中の組み込みスキル (本文を右ペイン / シートへ出す) */
  selectedBuiltin?: string | null;
  onSelectBuiltin?: (name: string) => void;
};

/**
 * 共通スキル (`.agents/skills`) と組み込みスキルの読み取り専用一覧。ファイルスキルは編集・削除・
 * エージェント割り当ての操作を持たず、組み込みは本文ビューだけを開ける (編集はできない)。
 * 同名はサーバー側で優先順位により一意化済みで、影になった側 / 上書きされた組み込みを警告として出す。
 */
export function FileSkillList({ state, onReload, selectedBuiltin = null, onSelectBuiltin }: FileSkillListProps) {
  const groups = state.status === "ready" ? groupFileSkills(state.skills) : { common: [], builtin: [] };
  return (
    <>
      <FileSkillGroup title={FILE_SKILL_GROUP_LABEL} onReload={onReload}>
        {state.status === "loading" ? <FileSkillNote>{FILE_SKILL_LOADING_NOTE}</FileSkillNote> : null}
        {state.status === "error" ? (
          <FileSkillNote tone="warn">
            {FILE_SKILL_ERROR_PREFIX}: {state.message}
          </FileSkillNote>
        ) : null}
        {state.status === "ready" && groups.common.length === 0 ? (
          <FileSkillNote>{FILE_SKILL_EMPTY_NOTE}</FileSkillNote>
        ) : null}
        {groups.common.map((skill) => (
          <FileSkillRow key={skill.path} skill={skill} />
        ))}
      </FileSkillGroup>
      {/* 組み込みは取得できたときだけ出す (失敗時はエラー表示だけで十分で、空のグループ見出しを増やさない) */}
      {state.status === "ready" ? (
        <FileSkillGroup title={BUILTIN_SKILL_GROUP_LABEL}>
          {groups.builtin.length === 0 ? <FileSkillNote>{BUILTIN_SKILL_EMPTY_NOTE}</FileSkillNote> : null}
          {groups.builtin.map((skill) => (
            <FileSkillRow
              key={skill.path}
              skill={skill}
              selected={selectedBuiltin === skill.name}
              onOpen={onSelectBuiltin ? () => onSelectBuiltin(skill.name) : undefined}
            />
          ))}
        </FileSkillGroup>
      ) : null}
    </>
  );
}

function FileSkillGroup({ title, onReload, children }: { title: string; onReload?: () => void; children: ReactNode }) {
  return (
    <section className="mt-3 grid min-w-0 content-start gap-1 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <h3 className="min-w-0 truncate text-2xs font-semibold tracking-widest text-ink-faint uppercase">{title}</h3>
        {onReload ? (
          <button
            type="button"
            onClick={onReload}
            aria-label="スキル一覧を再読み込み"
            className="btn-quiet shrink-0 px-1.5 py-0.5"
          >
            <RefreshIcon />
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function FileSkillNote({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p className={cn("px-2 text-2xs leading-4 break-words", tone === "warn" ? "text-warn" : "text-ink-muted")}>
      {children}
    </p>
  );
}

/** 行はファイルスキルではボタンにしない (読み取り専用で、押しても何も起きない選択状態を作らない)。 */
function FileSkillRow({
  skill,
  selected = false,
  onOpen,
}: {
  skill: FileSkillInfo;
  selected?: boolean;
  onOpen?: () => void;
}) {
  const warning = fileSkillWarning(skill);
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-xs leading-4">{skill.name}</span>
        <span className="shrink-0 text-2xs leading-4 text-ink-ghost">{FILE_SKILL_SCOPE_LABEL[skill.scope]}</span>
        {skill.version ? <span className="shrink-0 text-2xs leading-4 text-ink-ghost">v{skill.version}</span> : null}
        {skill.disableModelInvocation ? (
          <span className="shrink-0 text-2xs leading-4 text-ink-ghost">自動起動なし</span>
        ) : null}
      </span>
      <span className="truncate text-2xs leading-4 text-ink-soft">{skill.description || "説明なし"}</span>
      <code className="truncate text-2xs leading-4 text-ink-ghost">{skill.relativePath}</code>
      {warning ? (
        <span className={cn("text-2xs leading-4 break-words", warning === BUILTIN_SKILL_OVERRIDE_NOTE && "text-warn")}>
          {warning}
        </span>
      ) : null}
    </>
  );
  if (!onOpen) {
    return <div className="grid min-w-0 gap-1 rounded-lg px-2 py-1 text-ink">{body}</div>;
  }
  // 組み込みは本文ビューを開ける (読み取り専用なので編集フォームは出さない)
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onOpen}
      className={cn(
        "grid min-w-0 gap-1 rounded-lg px-2 py-1 text-left transition-colors",
        selected ? "bg-accent-wash text-accent-text" : "text-ink hover:bg-hover",
      )}
    >
      {body}
    </button>
  );
}
