import type { RuntimeStatus } from "../hooks/runtimeStatus";
import { RuntimeAlert } from "./RuntimeAlert";

export type TopbarProps = {
  runtimeStatus: RuntimeStatus;
};

export function Topbar({ runtimeStatus }: TopbarProps) {
  return (
    <header className="grid gap-3 px-6 pb-3 pt-5 wide:px-8 wide:pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">LOCAL WORKSPACE</div>
        {/* 正常時のモデルと接続状態は入力欄のピッカーや画面の様子から分かるので、エラーのときだけ出す */}
        {runtimeStatus.error ? (
          <div className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-danger/40 px-2.5 py-1.5 text-[11px] text-danger-text">
            <span className="dot dot-danger" aria-hidden />
            <span className="min-w-0 truncate">{runtimeStatus.text}</span>
          </div>
        ) : null}
      </div>
      <RuntimeAlert runtimeStatus={runtimeStatus} />
    </header>
  );
}
