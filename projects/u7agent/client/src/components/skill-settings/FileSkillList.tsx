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
  FILE_SKILL_RELOAD_ARIA_LABEL,
  FILE_SKILL_RELOAD_LABEL,
  FILE_SKILL_SCOPE_LABEL,
  FILE_SKILL_SECTION_LABEL,
  fileSkillWarning,
  groupFileSkills,
} from "../../lib/fileSkills";
import type { FileSkillInfo } from "../../types";
import { RefreshIcon } from "../icons";

export type FileSkillListProps = {
  state: FileSkillsState;
  onReload: () => void;
  /**
   * 選択中の読み取り専用スキル。上書きされた組み込みは同名の共通行と並ぶため、名前では 1 件に定まらない。
   * 行固有の path で照合する
   */
  selectedPath?: string | null;
  onSelect: (path: string) => void;
};

/**
 * 共通スキル (`.agents/skills`) と組み込みスキルの読み取り専用一覧。ファイルスキルは編集・削除・
 * エージェント割り当ての操作を持たず、行はどちらも本文ビューを開くだけ。同じ名前の行が残ることがあり
 * (上書きされた組み込み)、影になった側 / 上書きされた組み込みを警告として出す。
 */
export function FileSkillList({ state, onReload, selectedPath = null, onSelect }: FileSkillListProps) {
  const groups = state.status === "ready" ? groupFileSkills(state.skills) : { common: [], builtin: [] };
  // 共通行も組み込み行も同じ形 (押すと本文ビューが開く) なので、行の組み立ては 1 箇所に閉じる
  const rows = (skills: FileSkillInfo[]) =>
    skills.map((skill) => (
      <FileSkillRow
        key={skill.path}
        skill={skill}
        selected={selectedPath === skill.path}
        onOpen={() => onSelect(skill.path)}
      />
    ));
  return (
    <section className="mt-3 grid min-w-0 content-start gap-1 border-t border-line pt-3">
      {/* 再読み込みは両グループを包む見出しにだけ置く (グループ側に置くと片方だけ更新するように見える) */}
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <h3 className="min-w-0 truncate text-2xs font-semibold tracking-widest text-ink-faint uppercase">
          {FILE_SKILL_SECTION_LABEL}
        </h3>
        <button
          type="button"
          onClick={onReload}
          aria-label={FILE_SKILL_RELOAD_ARIA_LABEL}
          className="btn-quiet shrink-0 gap-1 px-1.5 py-0.5"
        >
          <RefreshIcon />
          {FILE_SKILL_RELOAD_LABEL}
        </button>
      </div>
      {state.status === "loading" ? <FileSkillNote>{FILE_SKILL_LOADING_NOTE}</FileSkillNote> : null}
      {state.status === "error" ? (
        <FileSkillNote tone="warn">
          {FILE_SKILL_ERROR_PREFIX}: {state.message}
        </FileSkillNote>
      ) : null}
      {state.status === "ready" ? (
        <>
          <FileSkillGroup title={FILE_SKILL_GROUP_LABEL}>
            {groups.common.length === 0 ? <FileSkillNote>{FILE_SKILL_EMPTY_NOTE}</FileSkillNote> : null}
            {rows(groups.common)}
          </FileSkillGroup>
          {/* 組み込みは取得できたときだけ出す (失敗時はエラー表示だけで十分で、空のグループ見出しを増やさない) */}
          <FileSkillGroup title={BUILTIN_SKILL_GROUP_LABEL} divided>
            {groups.builtin.length === 0 ? <FileSkillNote>{BUILTIN_SKILL_EMPTY_NOTE}</FileSkillNote> : null}
            {rows(groups.builtin)}
          </FileSkillGroup>
        </>
      ) : null}
    </section>
  );
}

/** 読み取り専用ブロックの中のグループ (共通 / 組み込み)。段は入れ子と字間で表し、色は親と揃える */
function FileSkillGroup({
  title,
  divided = false,
  children,
}: {
  title: string;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1", divided && "mt-1 border-t border-line/60 pt-2")}>
      {/* ink-ghost は eyebrow 用で、10px の見出しでは実測でも各テーマの 3:1 を下回る */}
      <h4 className="px-2 text-2xs font-semibold tracking-label text-ink-faint uppercase">{title}</h4>
      {children}
    </div>
  );
}

function FileSkillNote({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p className={cn("px-2 text-2xs leading-4 break-words", tone === "warn" ? "text-warn" : "text-ink-muted")}>
      {children}
    </p>
  );
}

/** 行全体が本文ビューを開く button になる (共通 / プロジェクトも読み取り専用で、押しても何も起きない行は作らない)。 */
function FileSkillRow({ skill, selected, onOpen }: { skill: FileSkillInfo; selected: boolean; onOpen: () => void }) {
  const warning = fileSkillWarning(skill);
  const identity = (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate text-xs leading-4">{skill.name}</span>
      <span className="shrink-0 text-2xs leading-4 text-ink-ghost">{FILE_SKILL_SCOPE_LABEL[skill.scope]}</span>
      {skill.version ? <span className="shrink-0 text-2xs leading-4 text-ink-ghost">v{skill.version}</span> : null}
      {skill.disableModelInvocation ? (
        <span className="shrink-0 text-2xs leading-4 text-ink-ghost">自動起動なし</span>
      ) : null}
    </span>
  );
  const details = (
    <>
      <span className="truncate text-2xs leading-4 text-ink-soft">{skill.description || "説明なし"}</span>
      <code className="truncate text-2xs leading-4 text-ink-ghost">{skill.relativePath}</code>
      {warning ? (
        <span className={cn("text-2xs leading-4 break-words", warning === BUILTIN_SKILL_OVERRIDE_NOTE && "text-warn")}>
          {warning}
        </span>
      ) : null}
    </>
  );
  // 本文ビューを開ける (読み取り専用なので編集フォームは出さない)。説明・パス・警告は button の
  // 外へ出して読み上げ名を名前行に閉じ、クリック領域は overlay で行全体のまま保つ (docs/api-catalog.md)
  return (
    <div
      className={cn(
        "relative grid min-w-0 gap-1 rounded-lg px-2 py-1 transition-colors",
        selected ? "bg-accent-wash text-accent-text" : "text-ink hover:bg-hover",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onOpen}
        className="min-w-0 text-left after:absolute after:inset-0"
      >
        {identity}
      </button>
      {details}
    </div>
  );
}
