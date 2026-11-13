import { useGitSettings, type GitSettings as GitSettingsState } from "../hooks/useGitSettings";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { TabToolbar } from "./TabToolbar";
import { GitSettingsTab } from "./git-settings/GitSettingsTab";

/**
 * 設定 → Git。hook はこの画面が持ち (開いたときだけ取得する)、
 * 再読み込みもこの画面の設定だけを取り直す。
 */
export function GitSettingsPage({ singleColumn, onBack, onOpenNav }: SettingsPageProps) {
  const gitSettings = useGitSettings();
  return (
    <GitSettingsView gitSettings={gitSettings} singleColumn={singleColumn} onBack={onBack} onOpenNav={onOpenNav} />
  );
}

/** 表示だけを持つ部分。取得の成否は gitSettings が持ち、ここは描画に徹する */
export function GitSettingsView({
  gitSettings,
  singleColumn = false,
  onBack,
  onOpenNav,
}: SettingsPageProps & { gitSettings: GitSettingsState }) {
  const { settings, note, saving, reloading, reload, save, clear } = gitSettings;
  return (
    <SettingsPageLayout
      eyebrow="GIT"
      title="Git"
      caption="エージェントが commit するときの名前とメールアドレスを設定します。"
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
        <GitSettingsTab settings={settings} saving={saving} onSave={save} onClear={clear} />
      ) : (
        <SettingsPlaceholder label="Git の設定" note={note} />
      )}
    </SettingsPageLayout>
  );
}
