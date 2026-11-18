import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BACKUP_KEPT_NOTE,
  BACKUP_RESET_APPLYING_LABEL,
  BACKUP_RESET_APPLY_LABEL,
  BACKUP_RESET_CHECK_LABEL,
  BACKUP_RESET_DIALOG_TITLE,
  BACKUP_SKILL_LIMITS_NOTE,
  BACKUP_TARGET_LABELS,
  backupResetDoneNote,
} from "../../lib/backup";
import type { BackupResetFlow } from "../../lib/backupFlow";
import type { BackupExportCheck } from "../../types";
import { WorkDialog } from "../WorkDialog";

export type BackupResetDialogProps = {
  flow: Exclude<BackupResetFlow, { status: "idle" }>;
  /** 消える件数の見積り。取得できていないときは件数を出さない */
  check: BackupExportCheck | null;
  singleColumn?: boolean;
  onApply: () => void;
  onClose: () => void;
};

/**
 * 全削除の確認ダイアログ。件数と残るものを出し、「書き出し済み、または失ってもよい」のチェックを
 * 必須にする (docs/ui-layout.md)。実行は元に戻せないため danger トーンに揃える。
 */
export function BackupResetDialog({ flow, check, singleColumn = false, onApply, onClose }: BackupResetDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const headerCloseRef = useRef<HTMLButtonElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = flow.status === "applying";
  const done = flow.status === "done";

  // 完了するとフッターごと取り消しが消えるので、焦点を残る閉じる導線へ移す
  useEffect(() => {
    if (done) headerCloseRef.current?.focus();
  }, [done]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (flow.status === "confirm" && confirmed) onApply();
  };

  return (
    <WorkDialog
      eyebrow="BACKUP"
      title={BACKUP_RESET_DIALOG_TITLE}
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
      initialFocusRef={closeRef}
      // 完了するとフッター (キャンセル) が消えるので、焦点を残る閉じる導線へ移せるようにする
      closeButtonRef={headerCloseRef}
      // 完了後は実行するものが残らない。出口はヘッダーの X だけにする
      submit={
        done
          ? undefined
          : {
              label: busy ? BACKUP_RESET_APPLYING_LABEL : BACKUP_RESET_APPLY_LABEL,
              tone: "danger",
              disabled: busy || !confirmed,
            }
      }
      width="wide"
      body="dense"
      singleColumn={singleColumn}
    >
      <p className="break-words text-ink-soft">
        ユーザー定義のエージェント、自作の定型プロンプト、共通スキルを削除します。元に戻せません。
      </p>
      {check ? (
        <p className="break-words text-ink-strong">
          削除する件数:{" "}
          {check.entries.map((entry) => `${BACKUP_TARGET_LABELS[entry.target]} ${entry.count} 件`).join(" / ")}
        </p>
      ) : null}
      <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_KEPT_NOTE}</p>
      <p className="text-2xs leading-relaxed break-words text-ink-muted">{BACKUP_SKILL_LIMITS_NOTE}</p>
      {done ? (
        <p className="break-words text-ink-soft">{backupResetDoneNote(flow.result)}</p>
      ) : (
        <label className="flex items-start gap-2 rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-2 text-2xs leading-relaxed text-ink-strong">
          <input
            type="checkbox"
            className="mt-0.5 accent-focus"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
          />
          <span className="min-w-0 break-words">{BACKUP_RESET_CHECK_LABEL}</span>
        </label>
      )}
    </WorkDialog>
  );
}
