import { useState } from "react";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { Catalog } from "../types";
import { DefinitionList } from "./DefinitionList";
import { MenuItem } from "./MenuItem";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SkillEditorForm } from "./skill-settings/SkillEditorForm";
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
  // compact は編集をシートへ出すため、開いているかを editingId とは別に持つ (editingId の null は「新規」も意味する)
  const [sheetOpen, setSheetOpen] = useState(false);
  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  const selectSkill = (nextId: string | null) => {
    setEditingId(nextId);
    // desktop は同じ場所にフォームが残るので、シートの状態は触らない (回転で勝手に開かないように)
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
    </DefinitionList>
  );

  const editor = (
    <SkillEditorForm
      catalog={catalog}
      editingId={editingId}
      skill={editingSkill}
      showHeading={!compact}
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
        // 一覧がページ全高を使い、編集はシート (SettingsDetailSheet) へ出す
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
          title={editingSkill ? "スキルを編集" : "新しいスキル"}
          note={note}
          onClose={() => setSheetOpen(false)}
        >
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
