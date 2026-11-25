import { useVoiceInputSettings, type VoiceInputSettings } from "../hooks/useVoiceInputSettings";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { TabToolbar } from "./TabToolbar";
import { VoiceInputSettingsTab } from "./voice-input-settings/VoiceInputSettingsTab";

/** 設定 → 音声入力 */
export function VoiceInputSettingsPage({
  singleColumn,
  onBack,
  onOpenNav,
  onVoiceInputKeyChanged,
}: SettingsPageProps & { onVoiceInputKeyChanged?: () => void }) {
  const voiceInputSettings = useVoiceInputSettings();
  return (
    <VoiceInputSettingsView
      voiceInputSettings={voiceInputSettings}
      onVoiceInputKeyChanged={onVoiceInputKeyChanged}
      singleColumn={singleColumn}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

export function VoiceInputSettingsView({
  voiceInputSettings,
  onVoiceInputKeyChanged,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SettingsPageProps & { voiceInputSettings: VoiceInputSettings; onVoiceInputKeyChanged?: () => void }) {
  const { settings, note, saving, reloading, reload, saveKey, removeKey, testing, testOutcome, test } =
    voiceInputSettings;
  // キーの保存 / 削除が通ったら、入力欄のマイクの可用性を App に取り直させる (キーの正はサーバー)
  const handleSaveKey = async (apiKey: string): Promise<boolean> => {
    const saved = await saveKey(apiKey);
    if (saved) onVoiceInputKeyChanged?.();
    return saved;
  };
  const handleDeleteKey = async (): Promise<boolean> => {
    const removed = await removeKey();
    if (removed) onVoiceInputKeyChanged?.();
    return removed;
  };
  return (
    <SettingsPageLayout
      eyebrow="VOICE INPUT"
      title="音声入力"
      caption="録音の文字起こしに使う OpenAI のAPIキーを設定し、その場で録音を 1 回試せます。"
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
          onSaveKey={handleSaveKey}
          onDeleteKey={handleDeleteKey}
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
