import { useVoiceInputSettings, type VoiceInputSettings } from "../hooks/useVoiceInputSettings";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { TabToolbar } from "./TabToolbar";
import { VoiceInputSettingsTab } from "./voice-input-settings/VoiceInputSettingsTab";

/**
 * 設定 → 音声入力。hook はこの画面が持ち (開いたときだけ取得する)、
 * 再読み込みもこの画面の設定だけを取り直す。
 */
export function VoiceInputSettingsPage({ singleColumn, onBack, onOpenNav }: SettingsPageProps) {
  const voiceInputSettings = useVoiceInputSettings();
  return (
    <VoiceInputSettingsView
      voiceInputSettings={voiceInputSettings}
      singleColumn={singleColumn}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 表示だけを持つ部分。取得の成否は voiceInputSettings が持ち、ここは描画に徹する */
export function VoiceInputSettingsView({
  voiceInputSettings,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SettingsPageProps & { voiceInputSettings: VoiceInputSettings }) {
  const { settings, note, saving, reloading, reload, saveKey, removeKey, testing, testOutcome, test } =
    voiceInputSettings;
  return (
    <SettingsPageLayout
      eyebrow="VOICE INPUT"
      title="音声入力"
      caption="録音の文字起こしに使う OpenAI のAPIキーを設定します。"
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
        <VoiceInputSettingsTab
          settings={settings}
          saving={saving}
          onSaveKey={saveKey}
          onDeleteKey={removeKey}
          testing={testing}
          testOutcome={testOutcome}
          onTest={() => void test()}
        />
      ) : (
        <SettingsPlaceholder label="音声入力の設定" note={note} />
      )}
    </SettingsPageLayout>
  );
}
