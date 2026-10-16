import type { ReactNode } from "react";
import { RUNTIME_SUBSECTIONS, type RuntimeSubsection } from "../../lib/settingsNav";
import { SettingsPageLayout, type SettingsPageProps } from "../SettingsPageLayout";
import { SettingsTabs } from "../SettingsTabs";
import { TabToolbar } from "../TabToolbar";

/** 設定 → ランタイムの面が共通で受ける、外装の props */
export type RuntimeTabProps = SettingsPageProps & {
  runtimeSubsection: RuntimeSubsection;
  onSelectRuntimeSubsection?: (subsection: RuntimeSubsection) => void;
};

/**
 * 設定 → ランタイムの共通の外装。タイトルとタブ行を 1 回だけ描き、面は操作 (面のツールバー) と本文だけを
 * 渡す。eyebrow / title / caption はページの説明なので、タブを切り替えても変えない。
 */
export function RuntimeTabLayout({
  actions,
  children,
  runtimeSubsection,
  onSelectRuntimeSubsection,
  singleColumn,
  onBack,
  onOpenNav,
}: RuntimeTabProps & { actions?: ReactNode; children: ReactNode }) {
  return (
    <SettingsPageLayout
      eyebrow="RUNTIME"
      title="ランタイム"
      caption="接続状態と実行環境を診断し、公開中のサービスを確認・停止できます。"
      toolbar={actions ? <TabToolbar actions={actions} /> : undefined}
      tabs={
        <SettingsTabs
          items={RUNTIME_SUBSECTIONS}
          active={runtimeSubsection}
          onSelect={onSelectRuntimeSubsection}
          ariaLabel="ランタイムの設定"
          singleColumn={singleColumn}
        />
      }
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {children}
    </SettingsPageLayout>
  );
}
