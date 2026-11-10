import { useMemo, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { applyBackupRestore, backupExportUrl, getBackupExportCheck, planBackupRestore, resetDefinitions } from "../api";
import {
  BACKUP_EXPORT_HEADING,
  BACKUP_PAGE_TITLE,
  BACKUP_PLAINTEXT_NOTE,
  BACKUP_RESET_HEADING,
  BACKUP_RESTORE_HEADING,
  BACKUP_WILL_REPLACE_NOTE,
  BACKUP_KEPT_NOTE,
  BACKUP_SKILL_LIMITS_NOTE,
} from "../lib/backup";
import { ALL_BACKUP_TARGETS, createBackup, type Backup, type BackupState } from "../lib/backupFlow";
import type { BackupExportCheck, BackupTarget } from "../types";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { BackupExportTargets } from "./backup/BackupExportTargets";
import { BackupResetDialog } from "./backup/BackupResetDialog";
import { BackupRestoreDialog } from "./backup/BackupRestoreDialog";

export type BackupSettingsPageProps = SettingsPageProps & {
  /** 復元 / 全削除の後のカタログ取り直し */
  refreshCatalog: () => Promise<unknown> | void;
};

/** 設定 → バックアップ。書き出し / 復元 / 全削除の 3 つだけを置く (docs/backup.md) */
export function BackupSettingsPage({
  singleColumn = false,
  onBack,
  onOpenNav,
  refreshCatalog,
}: BackupSettingsPageProps) {
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: BACKUP_PLAINTEXT_NOTE, error: false });
  const [targets, setTargets] = useState<BackupTarget[]>([...ALL_BACKUP_TARGETS]);
  const [resetCheck, setResetCheck] = useState<BackupExportCheck | null>(null);

  const backup = useMemo<Backup>(
    () =>
      createBackup({
        checkExport: getBackupExportCheck,
        exportUrl: backupExportUrl,
        startDownload: (url, name) => {
          const link = document.createElement("a");
          link.href = url;
          link.download = name;
          link.rel = "noopener";
          link.click();
        },
        planRestore: planBackupRestore,
        applyRestore: applyBackupRestore,
        resetDefinitions,
        reload: () => {
          void refreshCatalog();
        },
        note: (text, error) => setNote({ text, error }),
      }),
    [refreshCatalog],
  );
  const state = useSyncExternalStore(backup.subscribe, backup.state) as BackupState;

  const toggleExportTarget = (target: BackupTarget) => {
    const next = targets.includes(target) ? targets.filter((item) => item !== target) : [...targets, target];
    // 1 つも選ぶと空の ZIP になるため、書き出しの対象は最後の 1 つを外せない
    if (next.length === 0) return;
    setTargets(next);
  };

  const onSelectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // 同じファイルを選び直せるよう、input は毎回空にする
    event.currentTarget.value = "";
    if (file) void backup.selectRestoreFile(file);
  };

  const openReset = async () => {
    try {
      setResetCheck(await getBackupExportCheck(ALL_BACKUP_TARGETS));
    } catch (error) {
      // 件数が取れなくても確認ダイアログは開く (件数だけを出さない)
      setResetCheck(null);
      setNote({ text: error instanceof Error ? error.message : String(error), error: true });
    }
    backup.openReset();
  };

  const exporting = state.exporting;

  return (
    <>
      <SettingsPageLayout
        eyebrow="BACKUP"
        title={BACKUP_PAGE_TITLE}
        caption="エージェント・定型プロンプト・共通スキルだけを 1 つの ZIP にまとめて持ち出し、別の環境へ復元します。"
        singleColumn={singleColumn}
        onBack={onBack}
        onOpenNav={onOpenNav}
        note={note}
      >
        <div className="grid min-h-0 min-w-0 scrollbar-thin content-start gap-4 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed wide:px-5">
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">{BACKUP_EXPORT_HEADING}</h3>
            <p className="text-2xs leading-relaxed break-words text-ink-muted">
              選んだ対象を 1 つの ZIP にまとめます。会話・プロジェクト・設定・API
              キー・プロジェクト側スキルは含まれません。
            </p>
            <BackupExportTargets
              targets={targets}
              all={ALL_BACKUP_TARGETS}
              disabled={exporting}
              onToggle={toggleExportTarget}
            />
            <button
              type="button"
              className="btn-primary w-fit singleColumn:min-h-11"
              disabled={exporting}
              onClick={() => void backup.exportBackup(targets)}
            >
              {exporting ? "確認しています…" : "書き出す"}
            </button>
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
              {BACKUP_RESTORE_HEADING}
            </h3>
            <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_WILL_REPLACE_NOTE}</p>
            <label className="btn-quiet w-fit cursor-pointer singleColumn:min-h-11">
              バックアップを選ぶ
              <input type="file" accept=".zip,application/zip" className="sr-only" onChange={onSelectFile} />
            </label>
            <p className="text-2xs leading-relaxed break-words text-ink-ghost">{BACKUP_KEPT_NOTE}</p>
            <p className="text-2xs leading-relaxed break-words text-ink-ghost">{BACKUP_SKILL_LIMITS_NOTE}</p>
          </section>

          <section className="grid gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
            <h3 className="text-2xs font-semibold tracking-widest text-danger-text uppercase">
              {BACKUP_RESET_HEADING}
            </h3>
            <p className="text-2xs leading-relaxed break-words text-ink-muted">
              ユーザー定義のエージェント（サンプルを含む）、自作の定型プロンプト、共通スキルを削除します。元に戻せません。
            </p>
            <button type="button" className="btn-danger w-fit singleColumn:min-h-11" onClick={() => void openReset()}>
              {BACKUP_RESET_HEADING}
            </button>
          </section>
        </div>
      </SettingsPageLayout>

      {state.restore.status === "idle" || state.restore.status === "done" ? null : (
        <BackupRestoreDialog
          flow={state.restore}
          singleColumn={singleColumn}
          onToggleTarget={(target) => void backup.toggleTarget(target)}
          onConfirmed={backup.setConfirmed}
          onApply={() => void backup.apply()}
          onClose={backup.closeRestore}
        />
      )}
      {state.reset.status === "idle" ? null : (
        <BackupResetDialog
          flow={state.reset}
          check={resetCheck}
          singleColumn={singleColumn}
          onApply={() => void backup.applyReset()}
          onClose={backup.closeReset}
        />
      )}
    </>
  );
}
