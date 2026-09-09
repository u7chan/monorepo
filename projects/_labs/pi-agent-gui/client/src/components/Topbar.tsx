import { ThemeSwitcher } from "../theme/ThemeSwitcher";
import type { RuntimeStatus } from "../hooks/useAgentDesk";

export type TopbarProps = {
  runtimeStatus: RuntimeStatus;
};

export function Topbar({ runtimeStatus }: TopbarProps) {
  return (
    <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5 max-nav:px-[18px] wide:px-8 wide:pt-6">
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">LOCAL WORKSPACE</div>
        <h1 className="mt-0.5 truncate text-lg font-semibold text-ink-strong max-nav:text-base">
          何を手伝いましょうか？
        </h1>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <ThemeSwitcher />
        <div
          className={[
            "inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11px]",
            runtimeStatus.error ? "border-danger/40 text-danger-text" : "border-line text-ink-soft",
          ].join(" ")}
        >
          <span className={runtimeStatus.error ? "dot dot-danger" : "dot dot-accent"} aria-hidden />
          <span className="min-w-0 truncate">{runtimeStatus.text}</span>
        </div>
      </div>
    </header>
  );
}
