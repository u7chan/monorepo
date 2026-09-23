import { useState } from "react";
import { useFileSkills } from "../hooks/useFileSkills";
import { FILE_SKILL_PANEL_HEADING } from "../lib/fileSkills";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { Catalog } from "../types";
import { DefinitionList } from "./DefinitionList";
import { MenuItem } from "./MenuItem";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { FileSkillList } from "./skill-settings/FileSkillList";
import { ReadOnlySkillPanel } from "./skill-settings/ReadOnlySkillPanel";
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
  const [selectedFileSkillName, setSelectedFileSkillName] = useState<string | null>(null);
  const fileSkills = useFileSkills();
  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  // 読み取り専用スキルは編集できないので、選んだときは本文ビューだけを出す (一覧の選択状態は名前で持つ。
  // 一覧は同名をスコープをまたいで一意化済みなので、名前で 1 件に定まる)
  const selectedFileSkill =
    selectedFileSkillName && fileSkills.state.status === "ready"
      ? fileSkills.state.skills.find((skill) => skill.name === selectedFileSkillName)
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
    setSelectedFileSkillName(null);
    setEditingId(nextId);
    // desktop はページ内のフォームをそのまま使う (docs/ui-layout.md の「compact の詳細シート」)
    if (compact) setSheetOpen(true);
  };

  const selectFileSkill = (name: string) => {
    setSelectedFileSkillName(name);
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
      emptyLabel="カタログのスキルはまだありません。「新しいスキル」から作成できます。"
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
        selectedName={selectedFileSkillName}
        onSelect={selectFileSkill}
      />
    </DefinitionList>
  );

  const editor = selectedFileSkill ? (
    // 選択を切り替えたら本文の取り直しが最初の 1 フレームから正しくなるよう、スキルごとに作り直す
    <ReadOnlySkillPanel key={selectedFileSkill.path} skill={selectedFileSkill} variant={compact ? "sheet" : "page"} />
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
      caption="エージェントへ割り当てるスキルの本文を定義します。共通・組み込みは読み取り専用で、本文を確認できます。"
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
          title={
            selectedFileSkill
              ? FILE_SKILL_PANEL_HEADING[selectedFileSkill.scope]
              : editingSkill
                ? "スキルを編集"
                : "新しいスキル"
          }
          note={note}
          onClose={() => setSheetOpen(false)}
        >
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
