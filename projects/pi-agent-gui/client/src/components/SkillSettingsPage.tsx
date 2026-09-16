import { useState, type FormEvent } from "react";
import { createSkill, deleteSkill, updateSkill } from "../api";
import type { Catalog } from "../types";
import { DEFINITIONS_NOTE, DefinitionTransfer } from "./DefinitionTransfer";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { CheckIcon, PlusIcon, TrashIcon } from "./icons";

type SkillForm = { name: string; description: string; prompt: string };

export type SkillSettingsPageProps = SettingsPageProps & {
  catalog: Catalog;
  refreshCatalog: () => Promise<Catalog>;
};

export function SkillSettingsPage({
  catalog,
  refreshCatalog,
  compact = false,
  onBack,
  onOpenNav,
}: SkillSettingsPageProps) {
  const [editingId, setEditingId] = useState<string | null>(() => catalog.skills[0]?.id ?? null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: DEFINITIONS_NOTE, error: false });
  const [skillForm, setSkillForm] = useState<SkillForm>({ name: "", description: "", prompt: "" });

  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 自分自身の state を render 中に調整し、古いフォームを DOM に commit しない (カタログ再読込時にも初期化する)。
  const [formSource, setFormSource] = useState<{ editingId: string | null; catalog: Catalog } | null>(null);
  if (formSource?.editingId !== editingId || formSource?.catalog !== catalog) {
    setFormSource({ editingId, catalog });
    setSkillForm({
      name: editingSkill?.name || "",
      description: editingSkill?.description || "",
      prompt: editingSkill?.prompt || "",
    });
  }

  const startNewSkill = () => {
    setEditingId(null);
    setNoteText("新しいスキルを作成します。");
  };

  const saveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = { name: skillForm.name, description: skillForm.description, prompt: skillForm.prompt };
    try {
      const result = editingId ? await updateSkill(editingId, payload) : await createSkill(payload);
      setEditingId(result.skill.id);
      await refreshCatalog();
      setNoteText("スキルを保存しました。エージェントに割り当てて使えます。");
    } catch (error) {
      setNoteText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const removeCurrentSkill = async () => {
    if (!editingId) return;
    if (!window.confirm("このスキルを削除しますか？")) return;
    try {
      await deleteSkill(editingId);
      setEditingId(null);
      const next = await refreshCatalog();
      setEditingId(next.skills[0]?.id ?? null);
      setNoteText("スキルを削除しました。割り当てからも外れました。");
    } catch (error) {
      setNoteText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const itemClass = (active: boolean) =>
    [
      // 長い説明文が一覧のグリッド幅を押し広げないようにする。
      "flex min-w-0 w-full cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
      active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
    ].join(" ");

  return (
    <SettingsPageLayout
      eyebrow="CONFIGURATION"
      title="スキル"
      caption="エージェントへ割り当てる指示を定義します。"
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
      actions={
        <DefinitionTransfer
          catalog={catalog}
          refreshCatalog={refreshCatalog}
          onImported={(next) => setEditingId(next.skills[0]?.id ?? null)}
          onNote={setNoteText}
        />
      }
      note={note}
    >
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] wide:grid-cols-[248px_minmax(0,1fr)] wide:grid-rows-1">
        <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
          <div className="flex items-baseline gap-1.5 border-b border-line px-3 py-2 text-2xs font-semibold tracking-widest text-ink-faint uppercase">
            <span>スキル一覧</span>
            <span className="font-normal">{catalog.skills.length}</span>
          </div>

          <div className="max-h-[30vh] min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-3 wide:max-h-none">
            <button
              type="button"
              onClick={startNewSkill}
              className="mb-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
            >
              <PlusIcon />
              新しいスキル
            </button>
            <div className="grid min-w-0 gap-1">
              {catalog.skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => setEditingId(skill.id)}
                  className={itemClass(editingId === skill.id)}
                >
                  <strong className="min-w-0 truncate text-xs text-ink">{skill.name}</strong>
                  <span className="min-w-0 truncate text-2xs text-ink-muted">{skill.description || "説明なし"}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <form onSubmit={saveSkill} className="mx-auto grid max-w-2xl gap-3">
            <div>
              <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
              <h3 className="text-sm font-semibold text-ink-strong">
                {editingSkill ? "スキルを編集" : "新しいスキル"}
              </h3>
            </div>
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
            <div className="flex gap-2 pt-1">
              {editingSkill ? (
                <button
                  type="button"
                  onClick={() => void removeCurrentSkill()}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
                >
                  <TrashIcon />
                  削除
                </button>
              ) : null}
              <button
                type="submit"
                className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent transition-colors hover:brightness-110"
              >
                <CheckIcon />
                保存
              </button>
            </div>
          </form>
        </section>
      </div>
    </SettingsPageLayout>
  );
}
