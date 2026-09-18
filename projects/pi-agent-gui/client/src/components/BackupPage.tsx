import { useRef, useState } from "react";
import { replaceCatalog } from "../api";
import {
  BACKUP_TARGETS,
  READY_BACKUP_TARGETS,
  backupTargetLabel,
  orderBackupTargets,
  type BackupTargetId,
} from "../lib/backupTargets";
import {
  backupTargetIdsIn,
  describeBackupPayload,
  parseBackupFile,
  parseDefinitionsPayload,
  serializeBackup,
  splitImportTargets,
  type BackupData,
  type BackupFile,
} from "../lib/backupFile";
import { THEMES } from "../theme/themes";
import { useTheme } from "../theme/ThemeProvider";
import type { Catalog, Project, SessionSummary } from "../types";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { BackupTargetRow } from "./backup/BackupTargetRow";
import { ImportPreviewCard } from "./backup/ImportPreviewCard";
import { ExportIcon, ImportIcon } from "./icons";

const EXPORT_NOTE = "エクスポートしたファイルはブラウザのダウンロードに保存されます。";

export type BackupPageProps = SettingsPageProps & {
  catalog: Catalog;
  projects: Project[];
  sessions: SessionSummary[];
  /** 取り込み後にカタログを取り直す (選択中エージェントの正規化も行われる) */
  refreshCatalog: () => Promise<Catalog>;
};

type PendingImport = { fileName: string; file: BackupFile };

export function BackupPage({
  catalog,
  projects,
  sessions,
  refreshCatalog,
  compact = false,
  onBack,
  onOpenNav,
}: BackupPageProps) {
  const [selected, setSelected] = useState<BackupTargetId[]>(() => READY_BACKUP_TARGETS.map((target) => target.id));
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: EXPORT_NOTE, error: false });
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 再描画で disabled になる前の連打も止める (state はイベント処理の終了まで反映されない)
  const busyRef = useRef(false);
  const { choice } = useTheme();

  const setNoteText = (text: string, error = false) => setNote({ text, error });
  // 表示・書き出し・適用の順序を対象の定義に揃える (選んだ順でファイルの中身が変わらないようにする)
  const selectedTargets = orderBackupTargets(selected);
  const allSelected = selectedTargets.length === READY_BACKUP_TARGETS.length;

  const targetDetails = (id: BackupTargetId): string[] => {
    switch (id) {
      case "definitions":
        return [`エージェント ${catalog.agents.length} 件 / スキル ${catalog.skills.length} 件`];
      case "projects":
        return [`${projects.length} 件`];
      case "sessions":
        return [`${sessions.length} 件`];
      case "appearance":
        return [
          choice === "system" ? "システムに従う" : (THEMES.find((theme) => theme.id === choice)?.label ?? choice),
        ];
    }
  };

  const toggleTarget = (id: BackupTargetId, next: boolean) => {
    setSelected((prev) => (next ? [...prev, id] : prev.filter((item) => item !== id)));
  };

  const toggleAll = () => {
    setSelected(allSelected ? [] : READY_BACKUP_TARGETS.map((target) => target.id));
  };

  const exportSelected = () => {
    const data: BackupData = {};
    for (const id of selectedTargets) {
      if (id === "definitions") data.definitions = { agents: catalog.agents, skills: catalog.skills };
    }
    const { fileName, text } = serializeBackup(selectedTargets, data, new Date());
    downloadText(fileName, text);
    setNoteText(`${fileName} に書き出しました。`);
  };

  const selectImportFile = async (file: File): Promise<void> => {
    try {
      const parsed = parseBackupFile(await file.text());
      const { blocked } = splitImportTargets(backupTargetIdsIn(parsed.data));
      if (blocked.length > 0) {
        throw new Error(`${blocked.map(backupTargetLabel).join(" / ")}の取り込みは準備中です`);
      }
      setPending({ fileName: file.name, file: parsed });
      setNoteText("取り込む内容を確認してください。");
    } catch (error) {
      setPending(null);
      setNoteText(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const cancelImport = () => {
    setPending(null);
    setNoteText("取り込みをやめました。データは変更していません。");
  };

  const applyImport = async (): Promise<void> => {
    // 適用中は入口を閉じる。二重適用と、先の完了が後から選んだファイルの確認カードを消すのを防ぐ
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const applied: BackupTargetId[] = [];
    try {
      // 形の検証 (prepareImport) を済ませてから適用する。途中まで適用してから失敗させない
      for (const step of prepareImport(pending.file)) {
        await step.apply();
        applied.push(step.id);
      }
      await refreshCatalog();
      setPending(null);
      setNoteText(
        `${applied.map(backupTargetLabel).join(" / ")}を読み込みました。適用するには新しい会話を開始してください。`,
      );
    } catch (error) {
      const head = applied.length > 0 ? `${applied.map(backupTargetLabel).join(" / ")}までは読み込みました。` : "";
      setNoteText(head + (error instanceof Error ? error.message : String(error)), true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const pendingIds = pending ? backupTargetIdsIn(pending.file.data) : [];
  const untouchedLabels = BACKUP_TARGETS.filter((target) => !pendingIds.includes(target.id)).map(
    (target) => target.label,
  );

  return (
    <SettingsPageLayout
      eyebrow="DATA"
      title="バックアップ"
      caption="アプリのデータをファイルへ書き出し、読み込み直します。"
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
      actions={
        <>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-quiet" disabled={busy}>
            <ImportIcon />
            インポート
          </button>
          <button
            type="button"
            onClick={exportSelected}
            className="btn-primary"
            disabled={busy || selectedTargets.length === 0}
          >
            <ExportIcon />
            {selectedTargets.length > 1 ? `選択した ${selectedTargets.length} 件をエクスポート` : "エクスポート"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void selectImportFile(file);
            }}
          />
        </>
      }
      note={note}
    >
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        {/* 確認カードはスクロール領域の外に置く。中で先頭に出すと、一覧を下まで見ているときにカードが
            画面外に現れ、何を置き換えるのかを見ないまま取り込むことになる */}
        {pending ? (
          <div className="px-4 pt-4">
            <div className="mx-auto max-w-2xl">
              <ImportPreviewCard
                fileName={pending.fileName}
                entries={pendingIds.map((id) => ({
                  label: backupTargetLabel(id),
                  detail: describeBackupPayload(id, pending.file.data[id]),
                }))}
                untouched={untouchedLabels}
                busy={busy}
                onCancel={cancelImport}
                onConfirm={() => void applyImport()}
              />
            </div>
          </div>
        ) : null}

        <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-2xl gap-3">
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
                  エクスポートする対象
                </div>
                <div className="flex items-center gap-2 text-2xs">
                  <span className="text-ink-muted">
                    {selectedTargets.length} / {READY_BACKUP_TARGETS.length} 件を選択中
                  </span>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-accent-text transition-colors hover:text-ink"
                  >
                    {allSelected ? "すべて解除" : "すべて選択"}
                  </button>
                </div>
              </div>
              <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-soft">
                {BACKUP_TARGETS.map((target) => (
                  <BackupTargetRow
                    key={target.id}
                    target={target}
                    details={targetDetails(target.id)}
                    checked={selectedTargets.includes(target.id)}
                    onToggle={(next) => toggleTarget(target.id, next)}
                  />
                ))}
              </div>
            </div>

            <p className="text-2xs leading-relaxed text-ink-ghost">
              作業ディレクトリのファイルは永続マウント側にあり、このバックアップの対象外です。
            </p>
          </div>
        </div>
      </div>
    </SettingsPageLayout>
  );
}

type ImportStep = { id: BackupTargetId; apply: () => Promise<void> };

/** 対象ごとの適用を組み立てる。準備中の対象を含むファイルは、1 つも適用せずここで止める */
function prepareImport(file: BackupFile): ImportStep[] {
  const steps: ImportStep[] = [];
  for (const id of backupTargetIdsIn(file.data)) {
    if (id !== "definitions") throw new Error(`${backupTargetLabel(id)}の取り込みは準備中です`);
    const payload = parseDefinitionsPayload(file.data[id]);
    steps.push({
      id,
      apply: async () => {
        await replaceCatalog(payload);
      },
    });
  }
  return steps;
}

function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // クリック直後に解放するとダウンロードが始まらないブラウザがあるため、次のタスクで解放する
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
