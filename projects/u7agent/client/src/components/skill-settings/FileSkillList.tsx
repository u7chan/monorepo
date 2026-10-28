import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { FileSkillsState } from "../../hooks/useFileSkills";
import { ALLOWLIST_SEARCH_EMPTY_NOTE } from "../../lib/allowlistText";
import {
  BUILTIN_SKILL_EMPTY_NOTE,
  BUILTIN_SKILL_GROUP_LABEL,
  BUILTIN_SKILL_OVERRIDE_NOTE,
  COMMON_SKILL_SECTION_LABEL,
  FILE_SKILL_ERROR_PREFIX,
  FILE_SKILL_LIST_COMMON_EMPTY_NOTE,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_SCOPE_LABEL,
  fileSkillScopeCounts,
  fileSkillUsageLabel,
  fileSkillWarning,
  filterFileSkills,
  groupFileSkills,
  type FileSkillScopeTab,
} from "../../lib/fileSkills";
import { skillUsageCount, type SkillUsage } from "../../lib/skillUsage";
import type { FileSkillInfo } from "../../types";

export type FileSkillListProps = {
  state: FileSkillsState;
  /** スコープタブ。「すべて」では組み込みを先頭に並べる */
  scope: FileSkillScopeTab;
  /** 検索語。表示だけを絞る */
  query: string;
  /** 使用中エージェント数。カタログ未取得のときは渡さない (0 と断定しない) */
  usage?: SkillUsage;
  /**
   * 選択中のファイルスキル。上書きされた組み込みは同名の共通行と並ぶため、名前では 1 件に定まらない。
   * 行固有の path で照合する
   */
  selectedRelativePath?: string | null;
  onSelect: (skill: FileSkillInfo) => void;
};

/** 行の右端に出す使用中エージェント数。未取得なら何も出さない */
function usageText(usage: SkillUsage | undefined, skill: FileSkillInfo): string | undefined {
  const count = skillUsageCount(usage, skill.relativePath);
  return count === undefined ? undefined : fileSkillUsageLabel(count);
}

/**
 * 共通スキル (`.agents/skills`) と組み込みスキルの一覧。共通行は本文ビューから編集・削除でき、
 * 組み込みは読み取り専用のままにする。同じ名前の行が残ることがあり (上書きされた組み込み)、
 * 影になった側 / 上書きされた組み込みを警告として出す。相対パスは詳細へ譲り、行は名前・版・説明・
 * 使用中エージェント数だけにする。
 */
export function FileSkillList({
  state,
  scope,
  query,
  usage,
  selectedRelativePath = null,
  onSelect,
}: FileSkillListProps) {
  if (state.status === "loading") {
    return <ListNote>{FILE_SKILL_LOADING_NOTE}</ListNote>;
  }
  if (state.status === "error") {
    return (
      <ListNote tone="warn">
        {FILE_SKILL_ERROR_PREFIX}: {state.message}
      </ListNote>
    );
  }
  const groups = groupFileSkills(state.skills);
  const counts = fileSkillScopeCounts(state.skills);
  const visible = filterFileSkills(state.skills, scope, query);
  const row = (skill: FileSkillInfo) => (
    <FileSkillRow
      key={skill.path}
      skill={skill}
      usage={usageText(usage, skill)}
      selected={selectedRelativePath === skill.relativePath}
      onOpen={() => onSelect(skill)}
    />
  );
  if (visible.length === 0) {
    // 選択中のスコープに 1 件も無いときは「検索外れ」と区別し、そのスコープの案内を出す
    // (共通 0 件 + 組み込み 3 件の「共通」タブを検索外れの文言にしない)
    if (counts[scope] === 0) {
      return <ListNote>{scope === "builtin" ? BUILTIN_SKILL_EMPTY_NOTE : FILE_SKILL_LIST_COMMON_EMPTY_NOTE}</ListNote>;
    }
    return <ListNote>{ALLOWLIST_SEARCH_EMPTY_NOTE}</ListNote>;
  }
  if (scope !== "all") {
    return <div className="grid min-w-0 content-start gap-1">{visible.map(row)}</div>;
  }
  const builtin = visible.filter((skill) => skill.scope === "builtin");
  const common = visible.filter((skill) => skill.scope !== "builtin");
  return (
    <div className="grid min-w-0 content-start gap-1">
      {groups.builtin.length > 0 ? (
        <FileSkillGroup title={`${BUILTIN_SKILL_GROUP_LABEL} ${counts.builtin}`}>{builtin.map(row)}</FileSkillGroup>
      ) : null}
      {groups.common.length > 0 ? (
        <FileSkillGroup title={`${COMMON_SKILL_SECTION_LABEL} ${counts.common}`} divided={groups.builtin.length > 0}>
          {common.map(row)}
        </FileSkillGroup>
      ) : null}
    </div>
  );
}

/** 読み取り専用ブロックの中のグループ。段は入れ子と字間で表し、色は親と揃える */
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
    <div className={cn("grid min-w-0 content-start gap-1", divided && "mt-1 border-t border-line pt-2")}>
      {/* ink-ghost は eyebrow 用で、10px の見出しでは実測でも各テーマの 3:1 を下回る */}
      <h4 className="px-2 text-2xs font-semibold tracking-label text-ink-faint uppercase">{title}</h4>
      {children}
    </div>
  );
}

function ListNote({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p className={cn("px-2 text-2xs leading-4 break-words", tone === "warn" ? "text-warn" : "text-ink-muted")}>
      {children}
    </p>
  );
}

/**
 * 行全体が本文ビューを開く button になる。読み上げ名は名前行 (名前 / スコープ / 版) に閉じ、
 * 説明・警告・使用中エージェント数は button の外へ出して行全体のクリックは overlay で保つ。
 */
function FileSkillRow({
  skill,
  usage,
  selected,
  onOpen,
}: {
  skill: FileSkillInfo;
  usage: string | undefined;
  selected: boolean;
  onOpen: () => void;
}) {
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
  return (
    <div
      data-skill-row={skill.relativePath}
      className={cn(
        "relative grid min-w-0 gap-1 rounded-lg px-2 py-1.5 transition-colors",
        selected ? "bg-accent-wash text-accent-text" : "text-ink hover:bg-hover",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <button
            type="button"
            aria-pressed={selected}
            onClick={onOpen}
            className="min-w-0 text-left after:absolute after:inset-0"
          >
            {identity}
          </button>
          <span className="truncate text-2xs leading-4 text-ink-soft" title={skill.description}>
            {skill.description || "説明なし"}
          </span>
        </div>
        {usage ? <span className="shrink-0 text-2xs leading-4 text-ink-muted">{usage}</span> : null}
      </div>
      {warning ? (
        <span className={cn("text-2xs leading-4 break-words", warning === BUILTIN_SKILL_OVERRIDE_NOTE && "text-warn")}>
          {warning}
        </span>
      ) : null}
    </div>
  );
}
