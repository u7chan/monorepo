import { ThemeSwitcher } from "../theme/ThemeSwitcher";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

/**
 * テーマの選択ページ。テーマ切替の入口をここに一本化し、Topbar と drawer のカードには置かない。
 */
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
      <div className="scrollbar-thin min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-2xl gap-3">
          <div className="grid gap-2 rounded-lg border border-line bg-soft px-3 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">テーマ</div>
            {/* compact では iOS Safari の focus 時ズームを避けるため 16px 以上にする */}
            <ThemeSwitcher compact={compact} />
            <p className="text-[10px] leading-relaxed text-ink-ghost">
              「システムに従う」を選ぶと OS の設定に追従します。色は入力欄・メッセージ・コードなど画面全体に反映されます。
            </p>
          </div>
        </div>
      </div>
    </SettingsPageLayout>
  );
}
