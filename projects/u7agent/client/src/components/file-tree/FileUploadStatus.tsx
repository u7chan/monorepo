import type { WorkspaceUploadTask } from "../../hooks/useWorkspaceUploads";
import { cn } from "../../lib/cn";
import { CloseIcon, RunSpinnerIcon } from "../icons";

export type FileUploadStatusProps = {
  tasks: readonly WorkspaceUploadTask[];
  /** 待機中 / 送信中がある。終わるまで閉じる導線を出さない */
  busy: boolean;
  onDismiss: () => void;
};

/** 決着した行の要約。成功と失敗が混ざるときは両方を出す (片方だけにしない) */
function summaryOf(tasks: readonly WorkspaceUploadTask[], busy: boolean): string {
  const pending = tasks.filter((task) => task.status === "queued" || task.status === "uploading").length;
  if (busy) return `アップロード中… 残り ${pending} 件`;
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "error").length;
  if (done > 0 && failed > 0) return `${done} 件をアップロードしました。${failed} 件は保存できませんでした`;
  if (done > 0) return `${done} 件をアップロードしました`;
  return `${failed} 件のファイルをアップロードできませんでした`;
}

/**
 * アップロードの進行と結果。1 ファイル = 1 行で、失敗した理由はその場に残す（成功した分だけを
 * 一覧の再取得で見せて失敗を消さない）。エラーが無い間は role="status"、あるときは role="alert"。
 */
export function FileUploadStatus({ tasks, busy, onDismiss }: FileUploadStatusProps) {
  if (tasks.length === 0) return null;
  const failed = tasks.filter((task) => task.status === "error");
  const renamed = tasks.filter((task) => task.status === "done" && task.renamed && task.savedName);
  return (
    <div
      role={failed.length > 0 ? "alert" : "status"}
      aria-live={failed.length > 0 ? undefined : "polite"}
      className={cn(
        "max-h-40 scrollbar-thin overflow-y-auto border-b border-line bg-raised px-4 py-2",
        failed.length > 0 && "border-danger/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {busy ? <RunSpinnerIcon /> : null}
        <p className={cn("min-w-0 flex-1 text-2xs", failed.length > 0 ? "text-danger-text" : "text-ink-soft")}>
          {summaryOf(tasks, busy)}
        </p>
        {!busy ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="アップロードの結果を閉じる"
            className="icon-button size-7 shrink-0"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {failed.length > 0 || renamed.length > 0 ? (
        <ul className="mt-1 grid gap-0.5">
          {failed.map((task) => (
            <li key={`error-${task.id}`} className="min-w-0 text-2xs break-words text-ink-muted">
              <span className="text-ink-soft">{task.name}</span> — {task.error}
            </li>
          ))}
          {/* 同名で連番になったファイルは、一覧の行名が要求名と違う理由をここで示す */}
          {renamed.map((task) => (
            <li key={`renamed-${task.id}`} className="min-w-0 text-2xs break-words text-ink-muted">
              {task.name} は同名があったため <span className="text-ink-soft">{task.savedName}</span> で保存しました
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
