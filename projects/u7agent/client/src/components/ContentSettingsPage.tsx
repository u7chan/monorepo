import { useContentSettings, type ContentSettings } from "../hooks/useContentSettings";
import { CONTENT_SUBSECTIONS, DEFAULT_CONTENT_SUBSECTION, type ContentSubsection } from "../lib/settingsNav";
import { ContentSettingsTab } from "./content-settings/ContentSettingsTab";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { SettingsTabs } from "./SettingsTabs";
import { TabToolbar } from "./TabToolbar";

export type ContentSettingsPageProps = SettingsPageProps & {
  /** URL が決めるタブ。既定は「画像生成」 */
  contentSubsection: ContentSubsection;
  onSelectContentSubsection: (subsection: ContentSubsection) => void;
};

/**
 * 設定 → コンテンツ生成。hook はこの画面が持ち (開いたときだけ取得する)、
 * 再読み込みもこの画面の設定だけを取り直す。
 */
export function ContentSettingsPage({
  contentSubsection,
  onSelectContentSubsection,
  singleColumn,
  onBack,
  onOpenNav,
}: ContentSettingsPageProps) {
  const contentSettings = useContentSettings();
  return (
    <ContentSettingsView
      contentSettings={contentSettings}
      contentSubsection={contentSubsection}
      onSelectContentSubsection={onSelectContentSubsection}
      singleColumn={singleColumn}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 表示だけを持つ部分。取得の成否は contentSettings が持ち、ここは描画に徹する */
export function ContentSettingsView({
  contentSettings,
  singleColumn = false,
  contentSubsection = DEFAULT_CONTENT_SUBSECTION,
  onSelectContentSubsection,
  onBack,
  onOpenNav,
}: SettingsPageProps & {
  contentSettings: ContentSettings;
  contentSubsection?: ContentSubsection;
  onSelectContentSubsection?: (subsection: ContentSubsection) => void;
}) {
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
    previewSpeech,
    refreshCatalog,
    refreshSpeechCatalog,
    speechSynced,
  } = contentSettings;
  // 取得前は面の中身が無く、未設定ではキーを保存して初めて選べるようになるため、その間はタブ行も出さない
  const tabs =
    settings?.configured === true ? (
      <SettingsTabs
        items={CONTENT_SUBSECTIONS.map((item) =>
          item.subsection === "speech" && !speechSynced
            ? {
                ...item,
                mark: true,
                ariaLabel: `${item.label}（現在の設定を確認できません）`,
              }
            : item,
        )}
        active={contentSubsection}
        onSelect={onSelectContentSubsection}
        ariaLabel="コンテンツ生成の設定"
        singleColumn={singleColumn}
      />
    ) : undefined;
  return (
    <SettingsPageLayout
      eyebrow="CONTENT"
      title="コンテンツ生成"
      caption="画像と音声の生成に使う OpenRouter のAPIキーとモデルを設定します。"
      // タブが無い（未設定 / 取得前）間も取り直せるよう、面のツールバーは常に出す
      toolbar={
        <TabToolbar
          actions={
            <ReloadButton onClick={() => void reload()} disabled={reloading}>
              再読み込み
            </ReloadButton>
          }
        />
      }
      tabs={tabs}
      note={note}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {settings ? (
        <ContentSettingsTab
          settings={settings}
          contentSubsection={contentSubsection}
          saving={saving}
          onSaveKey={saveKey}
          onDeleteKey={removeKey}
          onSaveSelection={saveSelection}
          onRefreshCatalog={refreshCatalog}
          onSaveSpeech={saveSpeech}
          onRefreshSpeechCatalog={refreshSpeechCatalog}
          onPreviewSpeech={previewSpeech}
          speechSynced={speechSynced}
        />
      ) : (
        <SettingsPlaceholder label="コンテンツ生成の設定" note={note} />
      )}
    </SettingsPageLayout>
  );
}
