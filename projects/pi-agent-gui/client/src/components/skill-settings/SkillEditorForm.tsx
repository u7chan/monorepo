import { useState, type FormEvent } from "react";
import { createSkill, deleteSkill, updateSkill } from "../../api";
import type { Catalog, SkillDef } from "../../types";
import { CheckIcon, TrashIcon } from "../icons";

type SkillForm = { name: string; description: string; prompt: string };

function skillFormOf(skill: SkillDef | undefined): SkillForm {
  return { name: skill?.name || "", description: skill?.description || "", prompt: skill?.prompt || "" };
}

/**
 * 編集対象の state はこのフォームが持つ。参照が変わった編集対象・カタログを render 中に検出して初期化する
 * (useEffect では古いフォームが 1 フレーム描画される)。
 */
export function SkillEditorForm({
  catalog,
  editingId,
  skill,
  showHeading = true,
  refreshCatalog,
  onSelectSkill,
  onNote,
  onDone,
}: {
  catalog: Catalog;
  editingId: string | null;
  skill: SkillDef | undefined;
  /** 詳細シートではシートのヘッダが見出しを持つ */
  showHeading?: boolean;
  refreshCatalog: () => Promise<Catalog>;
  onSelectSkill: (skillId: string | null) => void;
  onNote: (text: string, error?: boolean) => void;
  /** 保存 / 削除が成功した。compact はシートを閉じて一覧へ戻る */
  onDone?: () => void;
}) {
  const [skillForm, setSkillForm] = useState(() => skillFormOf(skill));
  // 値を初期化済みにしてから mount し、同じ値での再 render を避ける
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog }));

  if (formSource.editingId !== editingId || formSource.catalog !== catalog) {
    setFormSource({ editingId, catalog });
    setSkillForm(skillFormOf(skill));
  }

  const saveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = { name: skillForm.name, description: skillForm.description, prompt: skillForm.prompt };
    try {
      const result = editingId ? await updateSkill(editingId, payload) : await createSkill(payload);
      onSelectSkill(result.skill.id);
      await refreshCatalog();
      onNote("スキルを保存しました。エージェントに割り当てて使えます。");
      onDone?.();
    } catch (error) {
      onNote(error instanceof Error ? error.message : String(error), true);
    }
  };

  const removeCurrentSkill = async () => {
    if (!editingId) return;
    if (!window.confirm("このスキルを削除しますか？")) return;
    try {
      await deleteSkill(editingId);
      onSelectSkill(null);
      const next = await refreshCatalog();
      onSelectSkill(next.skills[0]?.id ?? null);
      onNote("スキルを削除しました。割り当てからも外れました。");
      onDone?.();
    } catch (error) {
      onNote(error instanceof Error ? error.message : String(error), true);
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form onSubmit={saveSkill} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-2xl gap-3">
            {showHeading ? (
              <div>
                <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
                <h3 className="text-sm font-semibold text-ink-strong">{skill ? "スキルを編集" : "新しいスキル"}</h3>
              </div>
            ) : null}
            <label className="grid gap-1 text-1xs text-ink-soft">
              名前
              <input
                className="field text-xs"
                required
                maxLength={80}
                value={skillForm.name}
                // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
                onChange={(e) => {
                  const name = e.currentTarget.value;
                  setSkillForm((p) => ({ ...p, name }));
                }}
              />
            </label>
            <label className="grid gap-1 text-1xs text-ink-soft">
              説明
              <input
                className="field text-xs"
                maxLength={300}
                value={skillForm.description}
                onChange={(e) => {
                  const description = e.currentTarget.value;
                  setSkillForm((p) => ({ ...p, description }));
                }}
              />
            </label>
            <label className="grid gap-1 text-1xs text-ink-soft">
              指示
              <textarea
                className="field min-h-36 text-xs leading-relaxed"
                rows={8}
                maxLength={8000}
                placeholder="例: 結論を先に述べ、根拠をファイル名付きで示す"
                value={skillForm.prompt}
                onChange={(e) => {
                  const prompt = e.currentTarget.value;
                  setSkillForm((p) => ({ ...p, prompt }));
                }}
              />
            </label>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          {skill ? (
            <button
              type="button"
              onClick={() => void removeCurrentSkill()}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
            >
              <TrashIcon />
              削除
            </button>
          ) : null}
          <button type="submit" className="btn-primary ml-auto">
            <CheckIcon />
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
