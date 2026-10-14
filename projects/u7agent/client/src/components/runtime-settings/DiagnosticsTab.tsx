import type { SessionSummary } from "../../types";
import { SessionDiagnosticsCard } from "../SessionDiagnosticsCard";
import { RuntimeTabLayout, type RuntimeTabProps } from "./RuntimeTabLayout";

/**
 * 設定 → ランタイム の「診断」面。取得・コピー・生ログはカード内で完結する。カードの「再読み込み」は対象の
 * 会話を選ぶまで押せないため、面のツールバーには何も置かない。
 */
export function DiagnosticsTab({
  sessions,
  openSessionId,
  ...tabProps
}: RuntimeTabProps & {
  /** セッション診断の対象候補 (最終使用の新しい順) */
  sessions: SessionSummary[];
  /** このタブで開いている会話 (未選択は空文字) */
  openSessionId: string;
}) {
  return (
    <RuntimeTabLayout {...tabProps}>
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-4xl gap-3">
          <SessionDiagnosticsCard sessions={sessions} openSessionId={openSessionId} />
        </div>
      </div>
    </RuntimeTabLayout>
  );
}
