import { useCloudflareSettings } from "../hooks/useCloudflareSettings";
import { SHARING_SUBSECTIONS, type SharingSubsection } from "../lib/settingsNav";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { SettingsTabs } from "./SettingsTabs";
import { CloudflareCard } from "./sharing-settings/CloudflareCard";
import { TabToolbar } from "./TabToolbar";

export type SharingSettingsPageProps = SettingsPageProps & {
  /** URL が決めるタブ。接続だけを実装しているため既定は接続 */
  sharingSubsection: SharingSubsection;
  onSelectSharingSubsection: (subsection: SharingSubsection) => void;
};

/**
 * 設定 → 共有。接続タブは Cloudflare の資格情報だけを扱う。共有コンテンツの一覧は
 * 公開 API の実装後に同じ画面のタブへ足す。
 */
export function SharingSettingsPage(props: SharingSettingsPageProps) {
  return <SharingSettingsView {...props} cloudflare={useCloudflareSettings()} />;
}

/** 表示だけを持つ部分。取得と変更は cloudflare が持ち、ここはタブと描画に徹する */
export function SharingSettingsView({
  cloudflare,
  sharingSubsection,
  onSelectSharingSubsection,
  singleColumn,
  onBack,
  onOpenNav,
}: SharingSettingsPageProps & { cloudflare: ReturnType<typeof useCloudflareSettings> }) {
  return (
    <SettingsPageLayout
      eyebrow="SHARING"
      title="共有"
      caption="公開先の接続と、公開したコンテンツを管理します。"
      toolbar={
        <TabToolbar
          actions={
            <ReloadButton onClick={() => void cloudflare.reload()} disabled={cloudflare.reloading}>
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
      note={cloudflare.note}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {cloudflare.settings ? (
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
