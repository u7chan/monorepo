import { useState, type FormEvent } from "react";
import { useFileSkills } from "../hooks/useFileSkills";
import { useWideLayout } from "../hooks/useLayoutMode";
import { FILE_SKILL_DELETE_LABEL, FILE_SKILL_EDIT_LABEL, FILE_SKILL_PANEL_HEADING } from "../lib/fileSkills";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import { fileSkillDeleteConfirmRequest, skillDiscardConfirmRequest } from "../lib/settingsConfirm";
import type { Catalog, FileSkillInfo } from "../types";
import { DefinitionList } from "./DefinitionList";
import { useConfirm } from "./ConfirmProvider";
import { MenuItem } from "./MenuItem";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { CatalogSkillPanel } from "./skill-settings/CatalogSkillPanel";
import { FileSkillEditorForm } from "./skill-settings/FileSkillEditorForm";
import { FileSkillList } from "./skill-settings/FileSkillList";
import { FileSkillPanel } from "./skill-settings/FileSkillPanel";
import { SkillEditorForm, skillFormDirty, skillFormOf, type SkillForm } from "./skill-settings/SkillEditorForm";
import { BoltIcon, PencilIcon, TrashIcon } from "./icons";

export type SkillSettingsPageProps = SettingsPageProps & {
  catalog: Catalog;
  refreshCatalog: () => Promise<Catalog>;
  /** プレビュー オリジンのブラウザから見たポート (health)。未取得は undefined */
  filePreviewPort?: number;
};

/** カタログスキルの表示。一覧で選ぶと閲覧ビュー、`編集` でフォームへ入る */
type SkillMode = "view" | "edit";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SkillSettingsPage({
  catalog,
  refreshCatalog,
  filePreviewPort,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SkillSettingsPageProps) {
  const [editingId, setEditingId] = useState<string | null>(() => catalog.skills[0]?.id ?? null);
  // 一覧と編集を並べるのは 900px 以上だけ。狭い desktop と singleColumn は「一覧ページ + 全画面シート」に統一する
  // (一覧が何件でも編集面を削られない。docs/ui-layout.md の「設定の一覧と編集の境界」)
  const wide = useWideLayout();
  const sheetMode = singleColumn || !wide;
  const confirm = useConfirm();
  const [mode, setMode] = useState<SkillMode>("view");
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  // ファイルスキルの選択は一覧の root 相対 relativePath で持つ (変更要求のキーと同じ。上書きされた
  // 組み込みは同名の共通行と並ぶため、名前では 1 件に定まらない)
  const [selectedFileSkillRel, setSelectedFileSkillRel] = useState<string | null>(null);
  // 同じ行を押し直したときも本文を取り直すための世代 (パネルの key に混ぜる)
  const [selectedFileSkillSeq, setSelectedFileSkillSeq] = useState(0);
  const fileSkills = useFileSkills();
  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  const selectedFileSkill =
    selectedFileSkillRel && fileSkills.state.status === "ready"
      ? fileSkills.state.skills.find((skill) => skill.relativePath === selectedFileSkillRel)
      : undefined;
  const fileSkillEditor = fileSkills.editor;
  // 共通スキルの本文と保存可否は編集内容 (detail) から出す。編集中はその下書きが正になる
  const selectedFileSkillDetail =
    selectedFileSkill &&
    selectedFileSkill.scope === "user" &&
    (fileSkillEditor.status === "view" || fileSkillEditor.status === "edit") &&
    fileSkillEditor.relativePath === selectedFileSkill.relativePath
      ? fileSkillEditor.detail
      : undefined;
  const editingFileSkill =
    selectedFileSkill &&
    fileSkillEditor.status === "edit" &&
    fileSkillEditor.relativePath === selectedFileSkill.relativePath
      ? fileSkillEditor
      : null;
  const creatingFileSkill = fileSkillEditor.status === "create" ? fileSkillEditor : null;
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 下書きはページが持つ。理由は docs/ui-layout.md の「設定の一覧と編集の境界」を参照。
  // 参照が変わった編集対象・カタログ・mode を render 中に検出して初期化する (useEffect では古いフォームが 1 フレーム描画される)。
  // mode を条件に含めるのは、同じスキルでも `編集` のたびに現行のカタログから作り直し、`キャンセル` で下書きを破棄するため
  const [skillForm, setSkillForm] = useState<SkillForm>(() => skillFormOf(editingSkill));
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog, mode }));
  if (formSource.editingId !== editingId || formSource.catalog !== catalog || formSource.mode !== mode) {
    setFormSource({ editingId, catalog, mode });
    setSkillForm(skillFormOf(editingSkill));
  }

  const selectSkill = (nextId: string | null) => {
    setSelectedFileSkillRel(null);
    setEditingId(nextId);
    setMode("view");
    // 並べて見られないときだけシートを開く (900px 以上はページ内のフォームをそのまま使う)
    if (sheetMode) setSheetOpen(true);
  };

  const startEditing = () => setMode("edit");

  const cancelEditing = () => {
    // 未保存の差分があるときだけ確認する (開いてすぐ戻る操作を止めない)
    void (async () => {
      if (skillFormDirty(skillForm, editingSkill) && !(await confirm(skillDiscardConfirmRequest()))) return;
      setMode("view");
    })();
  };

  const selectFileSkill = (skill: FileSkillInfo) => {
    setSelectedFileSkillRel(skill.relativePath);
    // 同じ行の押し直しでも本文を取り直す (ファイルは選択の外で書き換わる)
    setSelectedFileSkillSeq((seq) => seq + 1);
    if (skill.scope === "user") fileSkills.openDetail(skill.relativePath);
    if (sheetMode) setSheetOpen(true);
  };

  const startNewSkill = () => {
    setNoteText("新しいスキルを作成します。");
    selectSkill(null);
    // 新規は閲覧ビューを持たないのでフォームへ直行する
    setMode("edit");
  };

  /** 共通スキルの新規作成。名前と説明はサーバー側でも検証され、同名は 409 で止まる */
  const startNewFileSkill = () => {
    setSelectedFileSkillRel(null);
    fileSkills.startCreate();
    if (sheetMode) setSheetOpen(true);
  };

  const saveFileSkill = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void (async () => {
      const created = creatingFileSkill !== null;
      const result = await fileSkills.save();
      if (!result.ok) {
        setNoteText(result.message, true);
        return;
      }
      setSelectedFileSkillRel(result.relativePath);
      setNoteText(created ? "共通スキルを作成しました。" : "共通スキルを保存しました。");
      if (created) setSheetOpen(false);
    })();
  };

  const cancelFileSkillEdit = () => {
    void (async () => {
      // 未保存の入力があるときだけ確認する (取消は何も書き換えない)。新規の空フォームは確認しない
      const dirty = editingFileSkill
        ? fileSkills.dirty(editingFileSkill)
        : creatingFileSkill
          ? fileSkills.dirty(creatingFileSkill)
          : false;
      if (dirty && !(await confirm(skillDiscardConfirmRequest()))) return;
      if (creatingFileSkill) {
        setSelectedFileSkillRel(null);
        setSheetOpen(false);
      }
      fileSkills.cancelEdit();
    })();
  };

  /** 共通スキルの削除。確認はその時点の一覧 (delete-preview) を取り直してから出す */
  const removeFileSkill = () => {
    void (async () => {
      const relativePath = selectedFileSkillRel;
      if (!relativePath) return;
      try {
        const preview = await fileSkills.previewDelete(relativePath);
        if (!(await confirm(fileSkillDeleteConfirmRequest(preview)))) return;
        const result = await fileSkills.remove(preview.relativePath, preview.treeVersion);
        if (!result.ok) {
          setNoteText(result.message, true);
          return;
        }
        setSelectedFileSkillRel(null);
        setSheetOpen(false);
        setNoteText("共通スキルを削除しました。");
      } catch (error) {
        setNoteText(errorText(error), true);
      }
    })();
  };

  const list = (
    <DefinitionList
      title="スキル一覧"
      count={catalog.skills.length}
      addLabel="新しいスキル"
      emptyLabel="カタログのスキルはまだありません。「新しいスキル」から作成できます。"
      onAdd={startNewSkill}
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
        selectedRelativePath={selectedFileSkillRel}
        onSelect={selectFileSkill}
        onAdd={startNewFileSkill}
      />
    </DefinitionList>
  );

  const fileSkillActions =
    selectedFileSkill?.scope === "user" && selectedFileSkillDetail ? (
      <>
        {selectedFileSkillDetail.editable ? (
          <button type="button" onClick={fileSkills.startEdit} className="btn-quiet">
            <PencilIcon />
            {FILE_SKILL_EDIT_LABEL}
          </button>
        ) : null}
        <button
          type="button"
          onClick={removeFileSkill}
          className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-2 text-2xs text-danger-text transition-colors hover:bg-danger/10"
        >
          <TrashIcon />
          {FILE_SKILL_DELETE_LABEL}
        </button>
      </>
    ) : undefined;

  const editor = creatingFileSkill ? (
    <FileSkillEditorForm
      mode="create"
      draft={creatingFileSkill.draft}
      setDraft={fileSkills.setDraft}
      conflict={false}
      notice={creatingFileSkill.notice}
      variant={sheetMode ? "sheet" : "page"}
      onSave={saveFileSkill}
      onCancel={cancelFileSkillEdit}
    />
  ) : editingFileSkill ? (
    <FileSkillEditorForm
      mode="edit"
      draft={editingFileSkill.draft}
      setDraft={fileSkills.setDraft}
      conflict={editingFileSkill.conflict}
      notice={null}
      variant={sheetMode ? "sheet" : "page"}
      onSave={saveFileSkill}
      onCancel={cancelFileSkillEdit}
      onReload={() => fileSkills.openDetail(editingFileSkill.relativePath)}
      onDelete={removeFileSkill}
    />
  ) : selectedFileSkill ? (
    // 本文は選択のたびに取り直す。行が同じでも再選択で作り直せるよう、選択の世代も key に含める
    <FileSkillPanel
      key={`${selectedFileSkill.relativePath}:${selectedFileSkillSeq}`}
      skill={selectedFileSkill}
      detail={selectedFileSkillDetail}
      actions={fileSkillActions}
      variant={sheetMode ? "sheet" : "page"}
      filePreviewPort={filePreviewPort}
    />
  ) : editingSkill && mode === "view" ? (
    <CatalogSkillPanel
      skill={editingSkill}
      agents={catalog.agents}
      variant={sheetMode ? "sheet" : "page"}
      onEdit={startEditing}
    />
  ) : (
    <SkillEditorForm
      editingId={editingId}
      skill={editingSkill}
      form={skillForm}
      setForm={setSkillForm}
      variant={sheetMode ? "sheet" : "page"}
      refreshCatalog={refreshCatalog}
      onSelectSkill={selectSkill}
      onNote={setNoteText}
      onDone={() => setSheetOpen(false)}
      onCancel={editingSkill ? cancelEditing : undefined}
    />
  );

  // シートの見出しは表示中の面に合わせる (閲覧ビューに「スキルを編集」を残さない)
  const sheetTitle = creatingFileSkill
    ? "新しい共通スキル"
    : editingFileSkill && selectedFileSkill
      ? `${FILE_SKILL_PANEL_HEADING[selectedFileSkill.scope]}を編集`
      : selectedFileSkill
        ? FILE_SKILL_PANEL_HEADING[selectedFileSkill.scope]
        : editingSkill
          ? mode === "view"
            ? "スキル"
            : "スキルを編集"
          : "新しいスキル";

  return (
    <SettingsPageLayout
      eyebrow="SKILLS"
      title="スキル"
      caption="エージェントに割り当てるスキルを定義します。"
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={note}
    >
      {sheetMode ? (
        <div className="grid min-h-0 min-w-0 grid-rows-1">{list}</div>
      ) : (
        <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
          {list}
          {editor}
        </div>
      )}
      {sheetMode && sheetOpen ? (
        <SettingsDetailSheet eyebrow="SKILL" title={sheetTitle} note={note} onClose={() => setSheetOpen(false)}>
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
