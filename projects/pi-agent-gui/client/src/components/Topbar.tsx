import { cn } from "../lib/cn";
import type { RuntimeStatus } from "../hooks/runtimeStatus";
import { RuntimeAlert } from "./RuntimeAlert";
import { FolderIcon } from "./icons";

export type TopbarProps = {
  runtimeStatus: RuntimeStatus;
  /** 右パネル (セッションのファイル) のトグル。セッションが無い (root が決まらない) ときは渡さない */
  sessionFiles?: { open: boolean; onToggle: () => void };
};

export function Topbar({ runtimeStatus, sessionFiles }: TopbarProps) {
  return (
    <header className="grid gap-3 px-6 pt-5 pb-3 wide:px-8 wide:pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">LOCAL WORKSPACE</div>
        <div className="flex min-w-0 items-center gap-2">
          {/* 正常時のモデルと接続状態は入力欄のピッカーや画面の様子から分かるので、エラーのときだけ出す */}
          {runtimeStatus.error ? (
            <div className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border border-danger/40 px-2.5 py-1.5 text-1xs text-danger-text">
              <span className="dot dot-danger" aria-hidden />
              <span className="min-w-0 truncate">{runtimeStatus.text}</span>
            </div>
          ) : null}
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
    </header>
  );
}
