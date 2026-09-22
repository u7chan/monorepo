import type { BuiltinSkillInfo, SkillDef } from "../../types";

/** 組み込み行の見出しと注記。チェック済み・無効で出し、外せないことをここ 1 箇所で伝える */
const BUILTIN_SECTION_LABEL = "組み込み（全エージェントで常時有効）";
const BUILTIN_SECTION_NOTE = "アプリに同梱されているため、割り当てを外すことはできません。";

export function SkillSelector({
  skills,
  builtinSkills,
  selectedIds,
  onToggle,
}: {
  skills: SkillDef[];
  /** 全エージェントで常時有効な同梱スキル。カタログと違って外せないのでチェック済みの無効行で出す */
  builtinSkills: BuiltinSkillInfo[];
  selectedIds: string[];
  onToggle: (skillId: string, checked: boolean) => void;
}) {
  // カタログから消えた id が残っていても選択数が全件を超えないよう、実在するスキルだけ数える
  const selectedCount = skills.filter((skill) => selectedIds.includes(skill.id)).length;

  return (
    <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
        <span>スキル</span>
        <span className="font-normal">
          割り当て中 {selectedCount} / 全 {skills.length}
        </span>
      </div>
      {skills.length === 0 ? (
        <div className="text-1xs text-ink-faint">スキルがありません。「スキル」ページから作成できます。</div>
      ) : (
        <div className="max-h-72 scrollbar-thin overflow-x-hidden overflow-y-auto">
          <div className="grid gap-1">
            {skills.map((skill) => (
              // min-w-0: 説明を truncate すると行の min-content が説明の全幅になり、一覧の行が箱より広がる
              <label
                key={skill.id}
                className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg bg-raised px-2.5 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(skill.id)}
                  onChange={(e) => onToggle(skill.id, e.currentTarget.checked)}
                  className="mt-0.5 accent-focus"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-ink">{skill.name}</span>
                  {/* 説明の全文は「スキル」ページにあるので、ここは 1 行に切って title へ逃がす */}
                  <small className="block truncate text-2xs text-ink-muted" title={skill.description || ""}>
                    {skill.description || ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {builtinSkills.length > 0 ? (
        // 外せないので操作は持たず、チェック済みの無効行として「常時有効」を見せる
        <div className="grid gap-1 border-t border-line pt-2">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">{BUILTIN_SECTION_LABEL}</div>
          {builtinSkills.map((skill) => (
            <label
              key={skill.name}
              className="flex min-w-0 items-start gap-2 rounded-lg bg-raised px-2.5 py-1.5 text-ink-muted"
            >
              <input type="checkbox" checked disabled readOnly className="mt-0.5 accent-focus" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs">{skill.name}</span>
                <small className="block truncate text-2xs" title={skill.description || ""}>
                  {skill.description || ""}
                </small>
              </span>
            </label>
          ))}
          <p className="text-2xs leading-4 break-words text-ink-faint">{BUILTIN_SECTION_NOTE}</p>
        </div>
      ) : null}
    </div>
  );
}
