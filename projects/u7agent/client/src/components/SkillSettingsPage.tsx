import { useEffect, useRef, useState, type FormEvent } from "react";
import { useFileSkills, type FileSkillsState } from "../hooks/useFileSkills";
import { useFileSkillArchive } from "../hooks/useFileSkillArchive";
import { useWideLayout } from "../hooks/useLayoutMode";
import {
  FILE_SKILL_ADD_LABEL,
  FILE_SKILL_CREATE_HEADING,
  FILE_SKILL_EDIT_LABEL,
  FILE_SKILL_PANE_ERROR_NOTE,
  FILE_SKILL_PANE_LOADING_NOTE,
  FILE_SKILL_PANE_NOTE,
  FILE_SKILL_RELOAD_ARIA_LABEL,
  FILE_SKILL_RELOAD_LABEL,
  FILE_SKILL_SCOPE_LABEL,
  FILE_SKILL_SCOPE_TABS,
  SKILL_EXPORT_LABEL,
  SKILL_IMPORT_LABEL,
  type FileSkillScopeTab,
  fileSkillScopeCounts,
} from "../lib/fileSkills";
import { MEMORY_NOTE, RELOAD_ABOVE_NOTE } from "../lib/settingsNotes";
import { fileSkillDeleteConfirmRequest, skillDiscardConfirmRequest } from "../lib/settingsConfirm";
import { skillUsageByPath, type SkillUsage } from "../lib/skillUsage";
import type { CatalogResponse, FileSkillInfo } from "../types";
import { useConfirm } from "./ConfirmProvider";
import { DefinitionList } from "./DefinitionList";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { SettingsNoteRow } from "./SettingsNoteRow";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsSearchField } from "./SettingsSearchField";
import { SettingsTabs } from "./SettingsTabs";
import { LoadingMark } from "./LoadingMark";
import { TabToolbar } from "./TabToolbar";
import { ReloadButton } from "./ReloadButton";
import { FileSkillEditorForm } from "./skill-settings/FileSkillEditorForm";
import { FileSkillList } from "./skill-settings/FileSkillList";
import { FileSkillPanel } from "./skill-settings/FileSkillPanel";
import { SkillImportDialog } from "./skill-settings/SkillImportDialog";
import { DownloadIcon, PencilIcon, PlusIcon, SparkleIcon, SkillListIcon, UploadIcon } from "./icons";

export type SkillSettingsPageProps = SettingsPageProps & {
  /**
   * 使用中エージェント数の導出に使う共有カタログ。未取得 (ビルトインもユーザー定義も空) のときは
   * 0 と断定せず、件数を出さない
   */
  catalog?: CatalogResponse;
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
 * 選択が無いときの案内。一覧を取得できていない間は「新しいスキル」からの作成を案内しない
 * (追加行も出ないため、案内だけが残るとできない操作を促すことになる)。
 */
export function fileSkillPaneNote(state: FileSkillsState): string {
  if (state.status === "ready") return FILE_SKILL_PANE_NOTE;
  return state.status === "loading" ? FILE_SKILL_PANE_LOADING_NOTE : FILE_SKILL_PANE_ERROR_NOTE;
}

/** 一覧と詳細のどちらを見せるか。並列表示では使わない */
type SkillView = "list" | "detail";

/**
 * スキルの管理ページ。900px 以上の desktop では一覧と詳細を並べ、それ以外では同じページの中で
 * 一覧 ⇄ 詳細を切り替える (docs/ui-layout.md の「設定の一覧と編集の境界」)。
 */
export function SkillSettingsPage({
  catalog,
  filePreviewPort,
  rootCwd,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SkillSettingsPageProps) {
  const wide = useWideLayout();
  const split = !singleColumn && wide;
  const confirm = useConfirm();
  const [view, setView] = useState<SkillView>("list");
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  // スコープタブと検索は表示だけを絞る (個別の選択と詳細の対象は変えない)
  const [scope, setScope] = useState<FileSkillScopeTab>("all");
  const [query, setQuery] = useState("");
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

  // 使用中エージェント数。カタログ未取得のときは渡さず、0 と断定しない
  const catalogReady = catalog !== undefined && (catalog.builtinAgent !== null || catalog.agents.length > 0);
  const usage: SkillUsage | undefined =
    catalogReady && fileSkills.state.status === "ready"
      ? skillUsageByPath({
          agents: catalog.agents,
          skills: fileSkills.state.skills,
          builtinAgentId: catalog.builtinAgent?.id,
        })
      : undefined;

  const focusDetail = () => {
    if (!split) setView("detail");
  };

  /** インポートした共通スキルを選択して開く。一覧は適用後に取り直しているので、応答が届けば選択は戻る */
  const selectImportedFileSkill = (relativePath: string) => {
    setSelectedFileSkillRel(relativePath);
    setSelectedFileSkillSeq((seq) => seq + 1);
    fileSkills.openDetail(relativePath);
    focusDetail();
  };

  const selectFileSkill = (skill: FileSkillInfo) => {
    setSelectedFileSkillRel(skill.relativePath);
    // 同じ行の押し直しでも本文を取り直す (ファイルは選択の外で書き換わる)
    setSelectedFileSkillSeq((seq) => seq + 1);
    if (skill.scope === "user") fileSkills.openDetail(skill.relativePath);
    focusDetail();
  };

  /** 共通スキルの新規作成。名前と説明はサーバー側でも検証され、同名は 409 で止まる */
  const startNewFileSkill = () => {
    setSelectedFileSkillRel(null);
    fileSkills.startCreate();
    focusDetail();
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
      // 新規は保存後に一覧へ戻る (作成した行が選択された状態で見える)
      if (created && !split) setView("list");
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
        if (!split) setView("list");
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
        if (!split) setView("list");
        setNoteText("共通スキルを削除しました。");
      } catch (error) {
        setNoteText(errorText(error), true);
      }
    })();
  };

  /*
   * 一覧 ⇄ 詳細の焦点。詳細では見出し (ヘッダ) へ、戻ったときは選択中の行へ移す (docs/ui-layout.md)
   */
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousView = useRef<SkillView>(view);
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (split || previous === view) return;
    if (view === "detail") {
      detailRef.current?.focus();
      return;
    }
    const row = selectedFileSkillRel
      ? listRef.current?.querySelector<HTMLButtonElement>(
          `[data-skill-row="${CSS.escape(selectedFileSkillRel)}"] button`,
        )
      : undefined;
    (row ?? listRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [view, split, selectedFileSkillRel]);

  // 詳細の Escape は一覧へ戻す。capture で受けるのは、焦点が詳細の外へ落ちていても
  // App の「設定 → チャット」の Escape (window の bubble) より先に消費するため
  useEffect(() => {
    if (split || view !== "detail") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // モーダル / popover が開いている間は、そちらの標準の閉じ方に任せる
      if (document.querySelector("dialog[open], :popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      setView("list");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [split, view]);

  const archive = useFileSkillArchive({
    reloadSkills: fileSkills.reload,
    selectSkill: selectImportedFileSkill,
    note: setNoteText,
  });
  const archiveImportRef = useRef<HTMLInputElement>(null);

  const counts = fileSkills.state.status === "ready" ? fileSkillScopeCounts(fileSkills.state.skills) : undefined;
  const add = fileSkillAddRow(fileSkills.state, startNewFileSkill);
  const listErrorNote = fileSkills.state.status === "error" ? RELOAD_ABOVE_NOTE : null;

  // 一覧に属するファイル操作は、一覧を見ている間だけヘッダ直下の帯の右端に出す (設定 → モデルと同じ形)。
  // 詳細を開いている間と、隠れた一覧の上には出さない
  const fileOps =
    split || view === "list" ? (
      <>
        <button
          type="button"
          onClick={() => void archive.exportSkills()}
          disabled={archive.exporting}
          className="btn-quiet"
        >
          <DownloadIcon small />
          {SKILL_EXPORT_LABEL}
        </button>
        <button
          type="button"
          onClick={() => archiveImportRef.current?.click()}
          disabled={archive.import.status === "planning" || archive.import.status === "applying"}
          className="btn-quiet"
        >
          <UploadIcon small />
          {SKILL_IMPORT_LABEL}
        </button>
        <ReloadButton onClick={fileSkills.reload} aria-label={FILE_SKILL_RELOAD_ARIA_LABEL}>
          {FILE_SKILL_RELOAD_LABEL}
        </ReloadButton>
        <input
          ref={archiveImportRef}
          type="file"
          accept=".zip,application/zip"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            // 選択の取消 (files が空) では何もしない
            if (file) void archive.selectImportFile(file);
          }}
        />
      </>
    ) : undefined;

  const list = (
    <DefinitionList
      tabs={
        <SettingsTabs
          items={FILE_SKILL_SCOPE_TABS.map((tab) => ({
            subsection: tab.value,
            label: counts ? `${tab.label} ${counts[tab.value]}` : tab.label,
            ariaLabel: counts ? `${tab.label}（${counts[tab.value]} 件）` : tab.label,
          }))}
          active={scope}
          onSelect={setScope}
          ariaLabel="スキルの種類"
          singleColumn={singleColumn}
          // 並列表示の一覧列は 248px で、既定の余白だと 3 つのタブが 10px はみ出す
          dense={split}
        />
      }
      search={
        <SettingsSearchField
          value={query}
          onChange={setQuery}
          placeholder="名前・説明で絞り込む"
          ariaLabel="スキルを絞り込む"
        />
      }
      footer={
        add || listErrorNote ? (
          <div className="grid gap-1.5">
            {add ? (
              <button
                type="button"
                onClick={add.onAdd}
                className="flex min-h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-3 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
              >
                <PlusIcon />
                {add.label}
              </button>
            ) : null}
            {listErrorNote ? <p className="text-2xs leading-4 text-ink-muted">{listErrorNote}</p> : null}
          </div>
        ) : undefined
      }
    >
      <FileSkillList
        state={fileSkills.state}
        scope={scope}
        query={query}
        usage={usage}
        selectedRelativePath={selectedFileSkillRel}
        onSelect={selectFileSkill}
      />
    </DefinitionList>
  );

  const canEditSelected = selectedFileSkill?.scope === "user" && selectedFileSkillDetail?.editable === true;
  // 削除は編集フォームの操作行に 1 箇所だけ置く。狭い幅では編集もアイコンだけにして、
  // 現在名 (ピッカー) の幅を残す
  const actions = canEditSelected ? (
    <button
      type="button"
      onClick={fileSkills.startEdit}
      aria-label={FILE_SKILL_EDIT_LABEL}
      title={FILE_SKILL_EDIT_LABEL}
      className="btn-quiet min-h-11"
    >
      <PencilIcon />
      {singleColumn ? null : FILE_SKILL_EDIT_LABEL}
    </button>
  ) : undefined;

  // ピッカーはスコープ / 検索で絞り込んだ一覧ではなく全件を使う (検索中でも切り替え先を探せる)。
  // 選択中の行が一覧に無くても現在名は出す
  const pickerSkills = fileSkills.state.status === "ready" ? fileSkills.state.skills : [];
  const orderedPickerSkills = [
    ...pickerSkills.filter((skill) => skill.scope === "builtin"),
    ...pickerSkills.filter((skill) => skill.scope !== "builtin"),
  ];
  const pickerOptions: SelectMenuOption[] = orderedPickerSkills.map((skill): SelectMenuOption => ({
    value: skill.relativePath,
    label: skill.name,
    detail: skill.version ? `v${skill.version}` : undefined,
    description: skill.description || undefined,
    leading:
      skill.scope === "builtin" ? (
        <span className="text-ink-muted">
          <SparkleIcon />
        </span>
      ) : (
        <span className="text-accent-text">
          <SkillListIcon />
        </span>
      ),
  }));
  if (selectedFileSkill && !pickerOptions.some((option) => option.value === selectedFileSkill.relativePath)) {
    pickerOptions.unshift({
      value: selectedFileSkill.relativePath,
      label: selectedFileSkill.name,
      detail: selectedFileSkill.version ? `v${selectedFileSkill.version}` : undefined,
    });
  }

  const heading = creatingFileSkill
    ? FILE_SKILL_CREATE_HEADING
    : editingFileSkill && selectedFileSkill
      ? `${selectedFileSkill.name} を編集`
      : undefined;
  // ピッカーは一覧が隠れているときだけ出す (並べて見えている間は行の選択で切り替えられる)。
  // 選択が無い間も、切り替え先が無いので空のピッカー (名前も印も無い 1 つの chevron) を出さない。
  // 中身が何も無いヘッダだけが残らないよう、見出しも選択も無いときは行ごと落とす
  const showPicker = !split && heading === undefined && selectedFileSkill !== undefined;
  const showDetailHeader = heading !== undefined || selectedFileSkill !== undefined;

  const detailContent = creatingFileSkill ? (
    <FileSkillEditorForm
      mode="create"
      draft={creatingFileSkill.draft}
      setDraft={fileSkills.setDraft}
      conflict={false}
      notice={creatingFileSkill.notice}
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
      usage={usage}
      filePreviewPort={filePreviewPort}
      rootCwd={rootCwd}
      singleColumn={singleColumn}
    />
  ) : (
    // 選択が無いときの面。並列表示では右半分が丸ごと空くので、上端に文を置かず面の中央に寄せ、
    // 印と文を横に並べる (狭い面は一覧と詳細を切り替えるので、この面は出ない)
    <div className="grid min-h-0 min-w-0 flex-1 place-items-center px-6 py-8">
      <p className="flex max-w-md items-center gap-2 text-xs leading-relaxed text-ink-muted">
        {fileSkills.state.status === "loading" ? <LoadingMark /> : <SkillListIcon />}
        <span>{fileSkillPaneNote(fileSkills.state)}</span>
      </p>
    </div>
  );

  const detail = (
    <div
      className={
        showDetailHeader
          ? "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]"
          : "grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]"
      }
    >
      {showDetailHeader ? (
        <SettingsDetailHeader
          ref={detailRef}
          back={split ? undefined : { label: "スキル一覧へ", onClick: () => setView("list") }}
          // ピッカーは選択肢と同じ印をトリガーにも出すので、その左に重ねない (狭い幅で名前の幅を削る)
          leading={
            heading && selectedFileSkill ? (
              selectedFileSkill.scope === "builtin" ? (
                <SparkleIcon />
              ) : (
                <SkillListIcon />
              )
            ) : undefined
          }
          title={
            heading ? (
              <span className="truncate text-sm font-semibold text-ink-strong">{heading}</span>
            ) : selectedFileSkill && !showPicker ? (
              <span className="block truncate text-sm font-semibold text-ink-strong">{selectedFileSkill.name}</span>
            ) : showPicker && selectedFileSkill ? (
              <SelectMenu
                options={pickerOptions}
                value={selectedFileSkill.relativePath}
                label="スキルを切り替える"
                triggerClassName="min-h-11"
                onChange={(value) => {
                  const next = pickerSkills.find((skill) => skill.relativePath === value);
                  if (next) selectFileSkill(next);
                }}
              />
            ) : undefined
          }
          badge={
            // 版はピッカーの detail に 1 箇所だけ出す (ヘッダの badge と二重にしない)
            selectedFileSkill ? (
              <span className="rounded border border-accent/50 bg-accent-wash px-1.5 text-2xs leading-4 text-accent-text">
                {FILE_SKILL_SCOPE_LABEL[selectedFileSkill.scope]}
              </span>
            ) : undefined
          }
          actions={actions}
        />
      ) : null}
      {detailContent}
      {split ? null : <SettingsNoteRow note={note} />}
    </div>
  );

  return (
    <>
      <SettingsPageLayout
        eyebrow="SKILLS"
        title="スキル"
        caption="会話で使う手順書のライブラリ。共通スキルはファイル、組み込みはアプリ同梱です。"
        singleColumn={singleColumn}
        onOpenNav={onOpenNav}
        onBack={onBack}
        // 詳細を開いている間はページの説明を落とし、戻る / ☰ の操作行だけにする
        collapseHeader={singleColumn && view === "detail"}
        toolbar={fileOps ? <TabToolbar actions={fileOps} /> : undefined}
        note={split || view === "list" ? note : undefined}
      >
        {split ? (
          <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
            {list}
            {detail}
          </div>
        ) : (
          <div className="grid min-h-0 min-w-0 grid-rows-1">
            {/* 一覧は隠れている間も mount したままにする (検索語とスクロールを詳細との往復で失わない) */}
            <div
              ref={listRef}
              hidden={view === "detail"}
              inert={view === "detail"}
              className="grid min-h-0 grid-rows-1"
            >
              {list}
            </div>
            {view === "detail" ? detail : null}
          </div>
        )}
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
