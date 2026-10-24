import { useState } from "react";
import { useCloudflareSettings } from "../hooks/useCloudflareSettings";
import { useSharedContentsManager, type SharedContentsManager } from "../hooks/useSharedContentsManager";
import { sharedContentFilterCounts, type SharedContentsFilter } from "../lib/sharedContents";
import { SHARING_SUBSECTIONS, type SharingSubsection } from "../lib/settingsNav";
import type { SessionSummary } from "../types";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { SettingsTabs } from "./SettingsTabs";
import { CloudflareCard } from "./sharing-settings/CloudflareCard";
import { SharedContentsFilters } from "./sharing-settings/SharedContentsFilters";
import { SharedContentsTab } from "./sharing-settings/SharedContentsTab";
import { TabToolbar } from "./TabToolbar";

export type SharingSettingsPageProps = SettingsPageProps & {
  /** URL が決めるタブ。既定は共有コンテンツ */
  sharingSubsection: SharingSubsection;
  onSelectSharingSubsection: (subsection: SharingSubsection) => void;
  /** 全スペースの会話。共有物の会話が一覧に無いときに「セッション（削除済み）」を出す */
  sessions: readonly SessionSummary[];
  /** 会話一覧がいま信頼できるか（初回取得に成功し、直近の取得が失敗していない）。
   * 信頼できない間は「削除済み」と言い切らず、更新も無効にしない */
  sessionsLoaded: boolean;
};

/**
 * 設定 → 共有。共有コンテンツは公開した成果物の管理、接続は Cloudflare の資格情報だけを扱う。
 * 一覧の取得と操作は contents、接続は cloudflare が持ち、同じ画面のタブとして並べる。
 */
export function SharingSettingsPage(props: SharingSettingsPageProps) {
  const cloudflare = useCloudflareSettings();
  const contents = useSharedContentsManager();
  return <SharingSettingsView {...props} cloudflare={cloudflare} contents={contents} />;
}

/** 表示だけを持つ部分。取得と変更は cloudflare / contents が持ち、ここはタブと描画に徹する */
export function SharingSettingsView({
  cloudflare,
  contents,
  sessions,
  sessionsLoaded,
  sharingSubsection,
  onSelectSharingSubsection,
  singleColumn,
  onBack,
  onOpenNav,
}: SharingSettingsPageProps & {
  cloudflare: ReturnType<typeof useCloudflareSettings>;
  contents: SharedContentsManager;
}) {
  const [filter, setFilter] = useState<SharedContentsFilter>("all");
  const contentsTab = sharingSubsection === "contents";
  const counts = sharedContentFilterCounts(contents.items);
  return (
    <SettingsPageLayout
      eyebrow="SHARING"
      title="共有"
      caption="公開先の接続と、公開したコンテンツを管理します。"
      toolbar={
        <TabToolbar
          context={
            // 空の一覧に 0 件のフィルタだけを並べない (空状態の案内を主にする)
            contentsTab && contents.items.length > 0 ? (
              <SharedContentsFilters filter={filter} counts={counts} onSelect={setFilter} />
            ) : undefined
          }
          actions={
            <ReloadButton
              onClick={() => {
                void (contentsTab ? contents.reload() : cloudflare.reload());
              }}
              disabled={contentsTab ? contents.reloading : cloudflare.reloading}
            >
              再読み込み
            </ReloadButton>
          }
        />
      }
      tabs={
        <SettingsTabs
          items={SHARING_SUBSECTIONS}
          active={sharingSubsection}
          onSelect={onSelectSharingSubsection}
          ariaLabel="共有の設定"
          singleColumn={singleColumn}
        />
      }
      note={contentsTab ? undefined : cloudflare.note}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {contentsTab ? (
        <SharedContentsTab
          contents={contents}
          cloudflareConfigured={cloudflare.settings?.configured}
          sessions={sessions}
          sessionsLoaded={sessionsLoaded}
          filter={filter}
          onOpenConnections={() => onSelectSharingSubsection("connections")}
        />
      ) : cloudflare.settings ? (
        <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-3xl gap-3">
            <CloudflareCard
              settings={cloudflare.settings}
              saving={cloudflare.saving}
              onSave={cloudflare.save}
              onDelete={cloudflare.remove}
            />
          </div>
        </div>
      ) : (
        <SettingsPlaceholder label="Cloudflare の接続" note={cloudflare.note} />
      )}
    </SettingsPageLayout>
  );
}
