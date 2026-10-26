import { useState, type FormEvent } from "react";
import { useFileSkills, type FileSkillsState } from "../hooks/useFileSkills";
import { useFileSkillArchive } from "../hooks/useFileSkillArchive";
import { useWideLayout } from "../hooks/useLayoutMode";
import {
  FILE_SKILL_ADD_LABEL,
  FILE_SKILL_DELETE_LABEL,
  FILE_SKILL_EDIT_LABEL,
  FILE_SKILL_PANE_ERROR_NOTE,
  FILE_SKILL_PANE_LOADING_NOTE,
  FILE_SKILL_PANE_NOTE,
  FILE_SKILL_PANEL_HEADING,
} from "../lib/fileSkills";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import { fileSkillDeleteConfirmRequest, skillDiscardConfirmRequest } from "../lib/settingsConfirm";
import type { FileSkillInfo } from "../types";
import { DefinitionList } from "./DefinitionList";
import { useConfirm } from "./ConfirmProvider";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { FileSkillEditorForm } from "./skill-settings/FileSkillEditorForm";
import { FileSkillList } from "./skill-settings/FileSkillList";
import { FileSkillPanel } from "./skill-settings/FileSkillPanel";
import { SkillImportDialog } from "./skill-settings/SkillImportDialog";
import { PencilIcon, TrashIcon } from "./icons";

export type SkillSettingsPageProps = SettingsPageProps & {
  /** プレビュー オリジンのブラウザから見たポート (health)。未取得は undefined */
  filePreviewPort?: number;
  /** ワークスペース root の絶対パス (health.cwd)。ファイルタブの行の絶対パスをコピーする導線に使う */
  rootCwd?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一覧の先頭に置く「新しいスキル」の追加行。取得できていない間は保存先も一覧も無く、入力のあとに
 * 失敗するだけなので出さない (取得中 / 失敗の理由は一覧側の注記と再読み込みが示す)。
 */
export function fileSkillAddRow(
  state: FileSkillsState,
  startCreate: () => void,
): { label: string; onAdd: () => void } | undefined {
  return state.status === "ready" ? { label: FILE_SKILL_ADD_LABEL, onAdd: startCreate } : undefined;
}

/**
 * 選択が無いときの右ペインの案内。一覧を取得できていない間は「新しいスキル」からの作成を案内しない
 * (追加行も出ないため、案内だけが残るとできない操作を促すことになる)。
 */
export function fileSkillPaneNote(state: FileSkillsState): string {
  if (state.status === "ready") return FILE_SKILL_PANE_NOTE;
  return state.status === "loading" ? FILE_SKILL_PANE_LOADING_NOTE : FILE_SKILL_PANE_ERROR_NOTE;
}

export function SkillSettingsPage({
  filePreviewPort,
  rootCwd,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SkillSettingsPageProps) {
  // 一覧と編集を並べるのは 900px 以上だけ。狭い desktop と singleColumn は「一覧ページ + 全画面シート」に統一する
  // (一覧が何件でも編集面を削られない。docs/ui-layout.md の「設定の一覧と編集の境界」)
  const wide = useWideLayout();
  const sheetMode = singleColumn || !wide;
  const confirm = useConfirm();
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  // ファイルスキルの選択は一覧の root 相対 relativePath で持つ (変更要求のキーと同じ。上書きされた
  // 組み込みは同名の共通行と並ぶため、名前では 1 件に定まらない)
  const [selectedFileSkillRel, setSelectedFileSkillRel] = useState<string | null>(null);
  // 同じ行を押し直したときも本文を取り直すための世代 (パネルの key に混ぜる)
  const [selectedFileSkillSeq, setSelectedFileSkillSeq] = useState(0);
  const fileSkills = useFileSkills();
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

  /** インポートした共通スキルを選択して開く。一覧は適用後に取り直しているので、応答が届けば選択は戻る */
  const selectImportedFileSkill = (relativePath: string) => {
    setSelectedFileSkillRel(relativePath);
    setSelectedFileSkillSeq((seq) => seq + 1);
    fileSkills.openDetail(relativePath);
    if (sheetMode) setSheetOpen(true);
  };

  const archive = useFileSkillArchive({
    reloadSkills: fileSkills.reload,
    selectSkill: selectImportedFileSkill,
    note: setNoteText,
  });

  const selectFileSkill = (skill: FileSkillInfo) => {
    setSelectedFileSkillRel(skill.relativePath);
    // 同じ行の押し直しでも本文を取り直す (ファイルは選択の外で書き換わる)
    setSelectedFileSkillSeq((seq) => seq + 1);
    if (skill.scope === "user") fileSkills.openDetail(skill.relativePath);
    if (sheetMode) setSheetOpen(true);
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
      count={fileSkills.state.status === "ready" ? fileSkills.state.skills.length : 0}
      add={fileSkillAddRow(fileSkills.state, startNewFileSkill)}
    >
      <FileSkillList
        state={fileSkills.state}
        onReload={fileSkills.reload}
        selectedRelativePath={selectedFileSkillRel}
        onSelect={selectFileSkill}
        archive={{
          exporting: archive.exporting,
          importing: archive.import.status === "planning" || archive.import.status === "applying",
          onExport: () => void archive.exportSkills(),
          onImportFile: (file) => void archive.selectImportFile(file),
        }}
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
      rootCwd={rootCwd}
    />
  ) : (
    <section className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        <p className="text-xs leading-relaxed text-ink-muted">{fileSkillPaneNote(fileSkills.state)}</p>
      </div>
    </section>
  );

  // シートの見出しは表示中の面に合わせる
  const sheetTitle = creatingFileSkill
    ? "新しい共通スキル"
    : editingFileSkill && selectedFileSkill
      ? `${FILE_SKILL_PANEL_HEADING[selectedFileSkill.scope]}を編集`
      : selectedFileSkill
        ? FILE_SKILL_PANEL_HEADING[selectedFileSkill.scope]
        : "スキル";

  return (
    <>
      <SettingsPageLayout
        eyebrow="SKILLS"
        title="スキル"
        caption="エージェントの会話で使うスキルを管理します。"
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
      {/* インポートの面は一覧の下に重ねる (背面の一覧は inert になり、二重のモーダルにしない) */}
      {archive.import.status === "idle" ? null : (
        <SkillImportDialog
          flow={archive.import}
          singleColumn={singleColumn}
          onToggleReplace={archive.toggleReplace}
          onSetReplaceAll={archive.setReplaceAll}
          onApply={() => void archive.applyImport()}
          onClose={archive.closeImport}
        />
      )}
    </>
  );
}
