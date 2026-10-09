import { useContentSettings, type ContentSettings } from "../hooks/useContentSettings";
import { ContentSettingsTab } from "./content-settings/ContentSettingsTab";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";

/**
 * 設定 → コンテンツ生成。hook はこの画面が持ち (開いたときだけ取得する)、
 * 再読み込みもこの画面の設定だけを取り直す。
 */
export function ContentSettingsPage({ compact, onBack, onOpenNav }: SettingsPageProps) {
  const contentSettings = useContentSettings();
  return (
    <ContentSettingsView contentSettings={contentSettings} compact={compact} onBack={onBack} onOpenNav={onOpenNav} />
  );
}

/** 表示だけを持つ部分。取得の成否は contentSettings が持ち、ここは描画に徹する */
export function ContentSettingsView({
  contentSettings,
  compact = false,
  onBack,
  onOpenNav,
}: SettingsPageProps & { contentSettings: ContentSettings }) {
  const {
    settings,
    note,
    saving,
    reloading,
    reload,
    saveKey,
    removeKey,
    saveSelection,
    saveSpeech,
    refreshCatalog,
    refreshSpeechCatalog,
    speechSynced,
  } = contentSettings;
  return (
    <SettingsPageLayout
      eyebrow="CONTENT"
      title="コンテンツ生成"
      caption="generate_image と generate_speech に使う OpenRouter のAPIキーとモデルを設定します。プロバイダーのキーとは別管理です。"
      actions={
        <ReloadButton onClick={() => void reload()} disabled={reloading}>
          再読み込み
        </ReloadButton>
      }
      note={note}
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {settings ? (
        <ContentSettingsTab
          settings={settings}
          saving={saving}
          onSaveKey={saveKey}
          onDeleteKey={removeKey}
          onSaveSelection={saveSelection}
          onRefreshCatalog={refreshCatalog}
          onSaveSpeech={saveSpeech}
          onRefreshSpeechCatalog={refreshSpeechCatalog}
          speechSynced={speechSynced}
        />
      ) : (
        <SettingsPlaceholder
          label="コンテンツ生成の設定"
          note={note}
          reloading={reloading}
          onReload={() => void reload()}
        />
      )}
    </SettingsPageLayout>
  );
}
