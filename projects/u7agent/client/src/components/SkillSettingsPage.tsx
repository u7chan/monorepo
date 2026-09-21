import { useState } from "react";
import { useFileSkills } from "../hooks/useFileSkills";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { Catalog } from "../types";
import { DefinitionList } from "./DefinitionList";
import { MenuItem } from "./MenuItem";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { BuiltinSkillPanel } from "./skill-settings/BuiltinSkillPanel";
import { FileSkillList } from "./skill-settings/FileSkillList";
import { SkillEditorForm, skillFormOf, type SkillForm } from "./skill-settings/SkillEditorForm";
import { BoltIcon } from "./icons";

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
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedBuiltin, setSelectedBuiltin] = useState<string | null>(null);
  const fileSkills = useFileSkills();
  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  // 組み込みは編集できないので、選んだときは本文ビューだけを出す (一覧の選択状態は名前で持つ)
  const builtinSkill =
    selectedBuiltin && fileSkills.state.status === "ready"
      ? fileSkills.state.skills.find((skill) => skill.scope === "builtin" && skill.name === selectedBuiltin)
      : undefined;
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 下書きはページが持つ。理由は docs/ui-layout.md の「compact の詳細シート」を参照。
  // 参照が変わった編集対象・カタログを render 中に検出して初期化する (useEffect では古いフォームが 1 フレーム描画される)
  const [skillForm, setSkillForm] = useState<SkillForm>(() => skillFormOf(editingSkill));
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog }));
  if (formSource.editingId !== editingId || formSource.catalog !== catalog) {
    setFormSource({ editingId, catalog });
    setSkillForm(skillFormOf(editingSkill));
  }

  const selectSkill = (nextId: string | null) => {
    setSelectedBuiltin(null);
    setEditingId(nextId);
    // desktop はページ内のフォームをそのまま使う (docs/ui-layout.md の「compact の詳細シート」)
    if (compact) setSheetOpen(true);
  };

  const selectBuiltin = (name: string) => {
    setSelectedBuiltin(name);
    if (compact) setSheetOpen(true);
  };

  const startNewSkill = () => {
    setNoteText("新しいスキルを作成します。");
    selectSkill(null);
  };

  const list = (
    <DefinitionList
      title="スキル一覧"
      count={catalog.skills.length}
      addLabel="新しいスキル"
      onAdd={startNewSkill}
      compact={compact}
    >
      {catalog.skills.map((skill) => (
        <MenuItem
          key={skill.id}
          icon={<BoltIcon />}
          label={skill.name}
          description={skill.description || "説明なし"}
          selected={editingId === skill.id}
          current="true"
          onClick={() => selectSkill(skill.id)}
        />
      ))}
      <FileSkillList
        state={fileSkills.state}
        onReload={fileSkills.reload}
        selectedBuiltin={selectedBuiltin}
        onSelectBuiltin={selectBuiltin}
      />
    </DefinitionList>
  );

  const editor = builtinSkill ? (
    <BuiltinSkillPanel skill={builtinSkill} variant={compact ? "sheet" : "page"} />
  ) : (
    <SkillEditorForm
      editingId={editingId}
      skill={editingSkill}
      form={skillForm}
      setForm={setSkillForm}
      variant={compact ? "sheet" : "page"}
      refreshCatalog={refreshCatalog}
      onSelectSkill={selectSkill}
      onNote={setNoteText}
      onDone={() => setSheetOpen(false)}
    />
  );

  return (
    <SettingsPageLayout
      eyebrow="CONFIGURATION"
      title="スキル"
      caption="エージェントへ割り当てる指示を定義します。"
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={note}
    >
      {compact ? (
        <div className="grid min-h-0 min-w-0 grid-rows-1">{list}</div>
      ) : (
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] wide:grid-cols-[248px_minmax(0,1fr)] wide:grid-rows-1">
          {list}
          {editor}
        </div>
      )}
      {compact && sheetOpen ? (
        <SettingsDetailSheet
          eyebrow="SKILL"
          title={builtinSkill ? "組み込みスキル" : editingSkill ? "スキルを編集" : "新しいスキル"}
          note={note}
          onClose={() => setSheetOpen(false)}
        >
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
