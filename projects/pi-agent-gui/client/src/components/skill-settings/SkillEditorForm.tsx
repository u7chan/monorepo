import type { Dispatch, FormEvent, SetStateAction } from "react";
import { createSkill, deleteSkill, updateSkill } from "../../api";
import type { Catalog, SkillDef } from "../../types";
import { CheckIcon, TrashIcon } from "../icons";

export type SkillForm = { name: string; description: string; prompt: string };

/** 下書き (SkillForm) はページが持つ。渡した編集対象から初期値を作る */
export function skillFormOf(skill: SkillDef | undefined): SkillForm {
  return { name: skill?.name ?? "", description: skill?.description ?? "", prompt: skill?.prompt ?? "" };
}

export function SkillEditorForm({
  editingId,
  skill,
  form,
  setForm,
  variant,
  refreshCatalog,
  onSelectSkill,
  onNote,
  onDone,
}: {
  editingId: string | null;
  skill: SkillDef | undefined;
  form: SkillForm;
  setForm: Dispatch<SetStateAction<SkillForm>>;
  /** page = ページ内の編集列、sheet = compact のシート (docs/ui-layout.md) */
  variant: "page" | "sheet";
  refreshCatalog: () => Promise<Catalog>;
  onSelectSkill: (skillId: string | null) => void;
  onNote: (text: string, error?: boolean) => void;
  /** 保存 / 削除が成功したときに呼ぶ */
  onDone?: () => void;
}) {
  const saveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = { name: form.name, description: form.description, prompt: form.prompt };
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

  const heading =
    variant === "page" ? (
      <div>
        <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
        <h3 className="text-sm font-semibold text-ink-strong">{skill ? "スキルを編集" : "新しいスキル"}</h3>
      </div>
    ) : null;

  const fields = (
    <>
      {heading}
      <label className="grid gap-1 text-1xs text-ink-soft">
        名前
        <input
          className="field text-xs"
          required
          maxLength={80}
          value={form.name}
          // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
          onChange={(e) => {
            const name = e.currentTarget.value;
            setForm((p) => ({ ...p, name }));
          }}
        />
      </label>
      <label className="grid gap-1 text-1xs text-ink-soft">
        説明
        <input
          className="field text-xs"
          maxLength={300}
          value={form.description}
          onChange={(e) => {
            const description = e.currentTarget.value;
            setForm((p) => ({ ...p, description }));
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
          value={form.prompt}
          onChange={(e) => {
            const prompt = e.currentTarget.value;
            setForm((p) => ({ ...p, prompt }));
          }}
        />
      </label>
    </>
  );

  const actions = (
    <>
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
      <button type="submit" className={variant === "page" ? "btn-primary flex-1" : "btn-primary ml-auto"}>
        <CheckIcon />
        保存
      </button>
    </>
  );

  // desktop のページは「本文の最後に操作行」、シートは「スクロール本文 + 下端に固定した操作行」で組む
  if (variant === "page") {
    return (
      <section className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <form onSubmit={saveSkill} className="mx-auto grid max-w-2xl gap-3">
          {fields}
          <div className="flex gap-2 pt-1">{actions}</div>
        </form>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form onSubmit={saveSkill} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-2xl gap-3">{fields}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">{actions}</div>
      </form>
    </section>
  );
}
