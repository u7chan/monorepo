import { ThemeSwitcher } from "../theme/ThemeSwitcher";
import { ThemeGallery } from "./appearance/ThemeGallery";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

/** テーマ切替の入口はここに一本化する (Topbar / drawer には置かない) */
export function AppearancePage({ compact = false, onBack, onOpenNav }: SettingsPageProps) {
  return (
    <SettingsPageLayout
      eyebrow="APPEARANCE"
      title="外観"
      caption="選んだテーマはこのブラウザに保存されます。"
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-3">
          <section className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">テーマ</div>
            <ThemeSwitcher compact={compact} />
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
        </div>
      </div>
    </SettingsPageLayout>
  );
}
