import { APPEARANCE_SUBSECTIONS, DEFAULT_APPEARANCE_SUBSECTION, type AppearanceSubsection } from "../lib/settingsNav";
import { ThemeSwitcher } from "../theme/ThemeSwitcher";
import { FileIconStyleSettings } from "./appearance/FileIconStyleSettings";
import { ThemeGallery } from "./appearance/ThemeGallery";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsTabs } from "./SettingsTabs";

export type AppearancePageProps = SettingsPageProps & {
  /** URL が決めるタブ。既定はテーマ (lib/settingsNav.ts) */
  appearanceSubsection?: AppearanceSubsection;
  onSelectAppearanceSubsection?: (subsection: AppearanceSubsection) => void;
};

/** 設定 → 外観。テーマ (色) とアイコン (ファイルツリーの見た目) をタブで分ける */
export function AppearancePage({
  singleColumn = false,
  appearanceSubsection = DEFAULT_APPEARANCE_SUBSECTION,
  onSelectAppearanceSubsection,
  onBack,
  onOpenNav,
}: AppearancePageProps) {
  return (
    <SettingsPageLayout
      eyebrow="APPEARANCE"
      title="外観"
      caption="選んだ設定はこのブラウザーに保存されます。"
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
      tabs={
        <SettingsTabs
          items={APPEARANCE_SUBSECTIONS}
          active={appearanceSubsection}
          onSelect={onSelectAppearanceSubsection}
          ariaLabel="外観"
          singleColumn={singleColumn}
        />
      }
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-3">
          {appearanceSubsection === "icons" ? (
            <FileIconStyleSettings />
          ) : (
            <>
              <section className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
                <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">テーマ</div>
                <ThemeSwitcher singleColumn={singleColumn} />
                <p className="text-2xs leading-relaxed text-ink-ghost">
                  「システムに従う」を選ぶと OS
                  の設定に追従します。色は入力欄・メッセージ・コードなど画面全体に反映されます。
                </p>
              </section>
              <section className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
                <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">プレビュー</div>
                <p className="text-2xs leading-relaxed text-ink-ghost">
                  各テーマの配色を縮小した画面で並べています。押すとすぐに切り替わります。
                </p>
                <ThemeGallery />
              </section>
            </>
          )}
        </div>
      </div>
    </SettingsPageLayout>
  );
}
