import { VERSION_MISMATCH_NOTICE } from "../lib/versionMismatch";
import { WarningIcon } from "./icons";

/**
 * 版ずれの案内 (docs/frontend.md#版ずれの案内)。表示中は再読み込みの導線だけを出し、
 * 自動では読み直さない。実行環境の診断行とは別の関心事なので、同じ面にまとめない。
 */
export function VersionMismatchBanner({ visible, onReload }: { visible: boolean; onReload: () => void }) {
  if (!visible) return null;
  return (
    <div className="px-6 pb-3 singleColumn:px-3">
      <div
        role="status"
        className="flex min-w-0 items-start gap-2 rounded-lg border border-warn/40 bg-raised px-3 py-2 text-warn-text"
      >
        <span className="mt-0.5 shrink-0">
          <WarningIcon />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-xs font-semibold">{VERSION_MISMATCH_NOTICE.heading}</p>
          <p className="text-2xs break-words opacity-90">{VERSION_MISMATCH_NOTICE.detail}</p>
        </div>
        <button type="button" onClick={onReload} className="btn-quiet shrink-0 text-2xs">
          {VERSION_MISMATCH_NOTICE.action}
        </button>
      </div>
    </div>
  );
}
