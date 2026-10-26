import { useSessionTitleSettings, type SessionTitleSettings } from "../hooks/useSessionTitleSettings";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { TabToolbar } from "./TabToolbar";
import { SessionTitleSettingsTab } from "./session-title-settings/SessionTitleSettingsTab";

/**
 * 設定 → 会話タイトル。hook はこの画面が持ち (開いたときだけ取得する)、
 * 再読み込みもこの画面の設定だけを取り直す。
 */
export function SessionTitleSettingsPage({ singleColumn, onBack, onOpenNav }: SettingsPageProps) {
  const sessionTitleSettings = useSessionTitleSettings();
  return (
    <SessionTitleSettingsView
      sessionTitleSettings={sessionTitleSettings}
      singleColumn={singleColumn}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 表示だけを持つ部分。取得の成否は sessionTitleSettings が持ち、ここは描画に徹する */
export function SessionTitleSettingsView({
  sessionTitleSettings,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SettingsPageProps & { sessionTitleSettings: SessionTitleSettings }) {
  const {
    settings,
    note,
    saving,
    reloading,
    reload,
    testing,
    testResult,
    test,
    setEnabled,
    setModel,
    setEffort,
    saveDefinition,
    resetDefinition,
  } = sessionTitleSettings;
  return (
    <SettingsPageLayout
      eyebrow="SESSION TITLE"
      title="会話タイトル"
      caption="依頼本文から作るタイトルを、AI要約で 1 回だけ整えます。"
      toolbar={
        <TabToolbar
          actions={
            <ReloadButton onClick={() => void reload()} disabled={reloading}>
              再読み込み
            </ReloadButton>
          }
        />
      }
      note={note}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {settings ? (
        <SessionTitleSettingsTab
          settings={settings}
          saving={saving}
          onSetEnabled={setEnabled}
          onSelectModel={setModel}
          onSelectEffort={setEffort}
          onSaveDefinition={saveDefinition}
          onResetDefinition={resetDefinition}
          testing={testing}
          testResult={testResult}
          onTest={() => void test()}
        />
      ) : (
        <SettingsPlaceholder label="会話タイトルの設定" note={note} />
      )}
    </SettingsPageLayout>
  );
}
