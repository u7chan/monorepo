import { DEFAULT_RUNTIME_SUBSECTION, type RuntimeSubsection } from "../lib/settingsNav";
import type { Health, SessionSummary } from "../types";
import type { SettingsPageProps } from "./SettingsPageLayout";
import { DiagnosticsTab } from "./runtime-settings/DiagnosticsTab";
import { EnvironmentTab } from "./runtime-settings/EnvironmentTab";
import { ServiceTab } from "./runtime-settings/ServiceTab";

type RuntimePageProps = SettingsPageProps & {
  /** URL が決めるタブ。既定は「サービス」 */
  runtimeSubsection?: RuntimeSubsection;
  onSelectRuntimeSubsection?: (subsection: RuntimeSubsection) => void;
  health: Health | null;
  /**
   * 親が持つ health の再取得。`isCurrent` を渡し、古い応答を親の state へ適用させない。
   * null (取得失敗 / キャンセル) は失敗として扱う。
   */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
  /** セッション診断の対象候補 (最終使用の新しい順) */
  sessions?: SessionSummary[];
  /** このタブで開いている会話 (未選択は空文字) */
  openSessionId?: string;
};

/**
 * 設定 → ランタイム。公開中のサービスの確認・停止（サービス）、接続状態と実行環境（環境）、
 * セッション診断（診断）をタブに分け、取得は面ごとに閉じる。表示の正は URL で、この画面は
 * 面を選ぶ switch に徹する（面の取得と表示はタブを切り替えると消える）。
 */
export function RuntimePage({
  runtimeSubsection = DEFAULT_RUNTIME_SUBSECTION,
  onSelectRuntimeSubsection,
  health,
  onRefreshHealth,
  onOpenSession,
  sessions = [],
  openSessionId = "",
  ...pageProps
}: RuntimePageProps) {
  const tabProps = {
    ...pageProps,
    runtimeSubsection,
    onSelectRuntimeSubsection,
  };
  switch (runtimeSubsection) {
    case "environment":
      return <EnvironmentTab {...tabProps} health={health} onRefreshHealth={onRefreshHealth} />;
    case "diagnostics":
      return <DiagnosticsTab {...tabProps} sessions={sessions} openSessionId={openSessionId} />;
    case "service":
      return (
        <ServiceTab {...tabProps} health={health} onRefreshHealth={onRefreshHealth} onOpenSession={onOpenSession} />
      );
    default: {
      // URL も App も既知の値だけを渡すため到達しない。空の面を出すより、気付ける形で落とす
      runtimeSubsection satisfies never;
      throw new Error(`未知のランタイムタブ: ${runtimeSubsection}`);
    }
  }
}
