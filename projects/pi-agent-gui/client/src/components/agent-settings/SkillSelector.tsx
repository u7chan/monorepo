import type { SkillDef } from "../../types";

/**
 * エージェントへ割り当てるスキルの一覧。件数が増えてもフォーム全体の高さを押し上げないよう、
 * 一覧だけを内部スクロールにし、選択状態は見出しで分かるようにする (スクロールしても数え直さなくてよい)。
 */
export function SkillSelector({
  skills,
  selectedIds,
  onToggle,
}: {
  skills: SkillDef[];
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
    </div>
  );
}
