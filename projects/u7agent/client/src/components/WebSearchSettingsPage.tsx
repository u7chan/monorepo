import { useWebSearchSettings, type WebSearchSettings } from "../hooks/useWebSearchSettings";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { WebSearchSettingsTab } from "./web-search-settings/WebSearchSettingsTab";

/**
 * 設定 → Web 検索。hook はこの画面が持ち (開いたときだけ取得する)、
 * 再読み込みもこの画面の設定だけを取り直す。
 */
export function WebSearchSettingsPage({
  singleColumn,
  refreshCatalog,
  onBack,
  onOpenNav,
}: SettingsPageProps & { refreshCatalog?: () => Promise<unknown> }) {
  const webSearchSettings = useWebSearchSettings();
  return (
    <WebSearchSettingsView
      webSearchSettings={webSearchSettings}
      singleColumn={singleColumn}
      refreshCatalog={refreshCatalog}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 表示だけを持つ部分。取得の成否は webSearchSettings が持ち、ここは描画に徹する */
export function WebSearchSettingsView({
  webSearchSettings,
  singleColumn = false,
  refreshCatalog,
  onBack,
  onOpenNav,
}: SettingsPageProps & {
  webSearchSettings: WebSearchSettings;
  /** ツールの `available` を取り直す (エージェント編集のツール欄が取得時点のスナップショットを見るため) */
  refreshCatalog?: () => Promise<unknown>;
}) {
  const { settings, note, saving, reloading, reload, setEnabled, setProvider, saveKey, removeKey } = webSearchSettings;
  // 実行時トグルを保存すると web_search の available が変わるので、成功後にカタログを取り直す
  const setEnabledAndRefresh = async (enabled: boolean): Promise<boolean> => {
    const saved = await setEnabled(enabled);
    if (saved) void refreshCatalog?.();
    return saved;
  };
  return (
    <SettingsPageLayout
      eyebrow="WEB SEARCH"
      title="Web 検索"
      caption="web_search ツールの有効 / 無効と、検索プロバイダーとキーを設定します。"
      actions={
        <ReloadButton onClick={() => void reload()} disabled={reloading}>
          再読み込み
        </ReloadButton>
      }
      note={note}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {settings ? (
        <WebSearchSettingsTab
          settings={settings}
          saving={saving}
          onSetEnabled={setEnabledAndRefresh}
          onSelectProvider={setProvider}
          onSaveKey={saveKey}
          onDeleteKey={removeKey}
        />
      ) : (
        <SettingsPlaceholder label="Web 検索の設定" note={note} />
      )}
    </SettingsPageLayout>
  );
}
