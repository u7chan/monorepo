import { useState } from "react";
import { useFileSkills } from "../hooks/useFileSkills";
import { FILE_SKILL_PANEL_HEADING } from "../lib/fileSkills";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import type { Catalog } from "../types";
import { DefinitionList } from "./DefinitionList";
import { MenuItem } from "./MenuItem";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { CatalogSkillPanel } from "./skill-settings/CatalogSkillPanel";
import { FileSkillList } from "./skill-settings/FileSkillList";
import { ReadOnlySkillPanel } from "./skill-settings/ReadOnlySkillPanel";
import { SkillEditorForm, skillFormDirty, skillFormOf, type SkillForm } from "./skill-settings/SkillEditorForm";
import { BoltIcon } from "./icons";

export type SkillSettingsPageProps = SettingsPageProps & {
  catalog: Catalog;
  refreshCatalog: () => Promise<Catalog>;
};

/** カタログスキルの表示。一覧で選ぶと閲覧ビュー、`編集` でフォームへ入る */
type SkillMode = "view" | "edit";

export function SkillSettingsPage({
  catalog,
  refreshCatalog,
  compact = false,
  onBack,
  onOpenNav,
}: SkillSettingsPageProps) {
  const [editingId, setEditingId] = useState<string | null>(() => catalog.skills[0]?.id ?? null);
  const [mode, setMode] = useState<SkillMode>("view");
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedFileSkillPath, setSelectedFileSkillPath] = useState<string | null>(null);
  // 同じ行を押し直したときも本文を取り直すための世代 (パネルの key に混ぜる)
  const [selectedFileSkillSeq, setSelectedFileSkillSeq] = useState(0);
  const fileSkills = useFileSkills();
  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  // 読み取り専用スキルは編集できないので、選んだときは本文ビューだけを出す。選択は行固有の path で持つ
  // (上書きされた組み込みは同名の共通行と並ぶため、名前では 1 件に定まらない)
  const selectedFileSkill =
    selectedFileSkillPath && fileSkills.state.status === "ready"
      ? fileSkills.state.skills.find((skill) => skill.path === selectedFileSkillPath)
      : undefined;
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 下書きはページが持つ。理由は docs/ui-layout.md の「compact の詳細シート」を参照。
  // 参照が変わった編集対象・カタログ・mode を render 中に検出して初期化する (useEffect では古いフォームが 1 フレーム描画される)。
  // mode を条件に含めるのは、同じスキルでも `編集` のたびに現行のカタログから作り直し、`キャンセル` で下書きを破棄するため
  const [skillForm, setSkillForm] = useState<SkillForm>(() => skillFormOf(editingSkill));
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog, mode }));
  if (formSource.editingId !== editingId || formSource.catalog !== catalog || formSource.mode !== mode) {
    setFormSource({ editingId, catalog, mode });
    setSkillForm(skillFormOf(editingSkill));
  }

  const selectSkill = (nextId: string | null) => {
    setSelectedFileSkillPath(null);
    setEditingId(nextId);
    setMode("view");
    // desktop はページ内のフォームをそのまま使う (docs/ui-layout.md の「compact の詳細シート」)
    if (compact) setSheetOpen(true);
  };

  const startEditing = () => setMode("edit");

  const cancelEditing = () => {
    // 未保存の差分があるときだけ確認する (開いてすぐ戻る操作を止めない)
    if (skillFormDirty(skillForm, editingSkill) && !window.confirm("編集中の変更を破棄しますか？")) return;
    setMode("view");
  };

  const selectFileSkill = (path: string) => {
    setSelectedFileSkillPath(path);
    // 同じ行の押し直しでも本文を取り直す (ファイルは選択の外で書き換わる)
    setSelectedFileSkillSeq((seq) => seq + 1);
    if (compact) setSheetOpen(true);
  };

  const startNewSkill = () => {
    setNoteText("新しいスキルを作成します。");
    selectSkill(null);
    // 新規は閲覧ビューを持たないのでフォームへ直行する
    setMode("edit");
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
        selectedPath={selectedFileSkillPath}
        onSelect={selectFileSkill}
      />
    </DefinitionList>
  );

  const editor = selectedFileSkill ? (
    // 本文は選択のたびに取り直す。行が同じでも再選択で作り直せるよう、選択の世代も key に含める
    <ReadOnlySkillPanel
      key={`${selectedFileSkill.path}:${selectedFileSkillSeq}`}
      skill={selectedFileSkill}
      variant={compact ? "sheet" : "page"}
    />
  ) : editingSkill && mode === "view" ? (
    <CatalogSkillPanel
      skill={editingSkill}
      agents={catalog.agents}
      variant={compact ? "sheet" : "page"}
      onEdit={startEditing}
    />
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
      onCancel={editingSkill ? cancelEditing : undefined}
    />
  );

  // シートの見出しは表示中の面に合わせる (閲覧ビューに「スキルを編集」を残さない)
  const sheetTitle = selectedFileSkill
    ? FILE_SKILL_PANEL_HEADING[selectedFileSkill.scope]
    : editingSkill
      ? mode === "view"
        ? "スキル"
        : "スキルを編集"
      : "新しいスキル";

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
        <SettingsDetailSheet eyebrow="SKILL" title={sheetTitle} note={note} onClose={() => setSheetOpen(false)}>
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
