import type { RuntimeStatus } from "../hooks/useAgentDesk";
import type { LayoutMode } from "../lib/layout";
import { MenuIcon } from "./icons";
import { RuntimeAlert } from "./RuntimeAlert";

export type CompactBarProps = {
  /** compact な 2 モード (desktop では Topbar を使う) */
  mode: Exclude<LayoutMode, "desktop">;
  /** 現在の会話 (無題なら新しい会話) */
  title: string;
  agentName?: string;
  runtimeStatus: RuntimeStatus;
  onOpenNav: () => void;
};

/**
 * モバイルの app bar。常時出すのは「どのエージェントのどの会話か」と nav の導線だけにして、
 * session 一覧 / エージェント管理 / 作業ディレクトリは NavSheet へ退避する。
 * landscape は高さが最も貴重なので 1 行に畳む。
 */
export function CompactBar({ mode, title, agentName, runtimeStatus, onOpenNav }: CompactBarProps) {
  const landscape = mode === "landscape";

  return (
    <header className="grid border-b border-line bg-panel/85">
      <div className={["flex items-center gap-2.5 px-3", landscape ? "py-0.5" : "py-2"].join(" ")}>
        <span
          aria-hidden
          className={[
            "grid shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent-wash text-accent-strong",
            landscape ? "size-6 text-[11px]" : "size-7 text-xs",
          ].join(" ")}
        >
          ✦
        </span>
        {landscape ? (
          <span className="shrink-0 text-[10px] text-ink-faint">{agentName || "エージェント未選択"}</span>
        ) : null}
        <div className="min-w-0 flex-1">
          {landscape ? null : (
            <div className="truncate text-[10px] text-ink-faint">{agentName || "エージェント未選択"}</div>
          )}
          <div
            className={[
              "truncate font-medium text-ink-strong",
              landscape ? "text-xs" : "text-[13px]",
            ].join(" ")}
          >
            {title}
          </div>
        </div>
        {runtimeStatus.error ? <span className="dot dot-danger shrink-0" aria-hidden /> : null}
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="ナビゲーションを開く"
          // 他の compact コントロールと同じ 36px のタップ領域を確保する
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
        >
          <MenuIcon />
        </button>
      </div>
      {runtimeStatus.error ? (
        <div className="px-2.5 pb-2">
          <RuntimeAlert runtimeStatus={runtimeStatus} compact />
        </div>
      ) : null}
    </header>
  );
}
