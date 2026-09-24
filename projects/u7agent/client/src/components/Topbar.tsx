import { cn } from "../lib/cn";
import type { RuntimeStatus } from "../hooks/runtimeStatus";
import { NotifyNote } from "./NotifyNote";
import { RuntimeAlert } from "./RuntimeAlert";
import { BellIcon, FolderIcon } from "./icons";

export type TopbarProps = {
  runtimeStatus: RuntimeStatus;
  /**
   * 会話の通知トグル。deliverable は今の On が実際に送られるか (色とラベルの根拠)。
   * note は配信できない理由で、On の間は常に、Off では押した後に出る
   */
  notify: { on: boolean; note?: string; deliverable: boolean; onToggle: () => void; onOpenSettings?: () => void };
  /** 右パネル (セッションのファイル) のトグル。セッションが無い (root が決まらない) ときは渡さない */
  sessionFiles?: { open: boolean; onToggle: () => void };
};

export function Topbar({ runtimeStatus, notify, sessionFiles }: TopbarProps) {
  // accent は「実際に送られる」の意味に保つ (設定が無効 / Webhook 未登録の On は青くしない)
  const delivering = notify.on && notify.deliverable;
  // 配信できない On は、押しても切り替わらない理由をラベルでも示す (色だけに頼らない)
  const notifyLabel = notify.on && !notify.deliverable ? "通知（停止中）" : "通知";
  return (
    <header className="grid gap-3 px-6 pt-5 pb-3 wide:px-8 wide:pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">LOCAL WORKSPACE</div>
        <div className="flex min-w-0 items-center gap-2">
          {/* 正常時のモデルは入力欄の上の状態行、接続状態は画面の様子から分かるので、エラーのときだけ出す */}
          {runtimeStatus.error ? (
            <div className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border border-danger/40 px-2.5 py-1.5 text-1xs text-danger-text">
              <span className="dot dot-danger" aria-hidden />
              <span className="min-w-0 truncate">{runtimeStatus.text}</span>
            </div>
          ) : null}
          <button
            type="button"
            aria-pressed={notify.on}
            onClick={notify.onToggle}
            className={cn("btn-quiet shrink-0", delivering && "border-accent/50 text-accent-text")}
          >
            <BellIcon ringing={notify.on} />
            {notifyLabel}
          </button>
          {sessionFiles ? (
            // ラベルは開閉で変えない (押した瞬間に幅が動くと、続けて押したいときに位置がずれる)
            <button
              type="button"
              aria-expanded={sessionFiles.open}
              onClick={sessionFiles.onToggle}
              className={cn("btn-quiet shrink-0", sessionFiles.open && "border-accent/50 text-accent-text")}
            >
              <FolderIcon />
              セッションのファイル
            </button>
          ) : null}
        </div>
      </div>
      <RuntimeAlert runtimeStatus={runtimeStatus} />
      {notify.note ? <NotifyNote text={notify.note} onOpenSettings={notify.onOpenSettings} /> : null}
    </header>
  );
}
