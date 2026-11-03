import { useContentSettings, type ContentSettings } from "../hooks/useContentSettings";
import { useContentTrials, type ContentTrials } from "../hooks/useContentTrials";
import { tabIndicator, trialKindSubsection } from "../lib/contentTrials";
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
  refreshToolCatalog,
  onBack,
  onOpenNav,
}: ContentSettingsPageProps & { refreshToolCatalog?: () => Promise<unknown> }) {
  const contentSettings = useContentSettings();
  // 未設定では履歴だけを見せる。タブを出すために一覧を種別で絞らない（設定済みならタブごとに絞る）
  const contentTrials = useContentTrials({
    activeSubsection: contentSubsection,
    kindScoped: contentSettings.settings?.configured === true,
  });
  return (
    <ContentSettingsView
      contentSettings={contentSettings}
      contentTrials={contentTrials}
      contentSubsection={contentSubsection}
      onSelectContentSubsection={onSelectContentSubsection}
      singleColumn={singleColumn}
      refreshToolCatalog={refreshToolCatalog}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 表示だけを持つ部分。取得の成否は contentSettings が持ち、ここは描画に徹する */
export function ContentSettingsView({
  contentSettings,
  contentTrials,
  singleColumn = false,
  contentSubsection = DEFAULT_CONTENT_SUBSECTION,
  onSelectContentSubsection,
  refreshToolCatalog,
  onBack,
  onOpenNav,
}: SettingsPageProps & {
  contentSettings: ContentSettings;
  contentTrials: ContentTrials;
  contentSubsection?: ContentSubsection;
  onSelectContentSubsection?: (subsection: ContentSubsection) => void;
  /** 有効 / 無効でツールの `available` が変わるため、保存後にエージェントの一覧を取り直す */
  refreshToolCatalog?: () => Promise<unknown>;
}) {
  const {
    settings,
    note,
    saving,
    reloading,
    reload,
    setEnabled,
    saveKey,
    removeKey,
    saveSelection,
    saveSpeech,
    refreshCatalog,
    refreshSpeechCatalog,
    speechSynced,
  } = contentSettings;
  // 取得前は面の中身が無い。未設定でも試行の履歴があれば読めるようにタブを出す（新規生成だけを止める）
  const trialList = contentTrials.trials ?? [];
  // キーの保存 / 削除で世代が変わったら、一覧を取り直さなくても証拠と「旧キー」の判定を追随させる
  const trialKeyEpoch = settings?.keyEpoch ?? contentTrials.keyEpoch;
  const tabs =
    settings?.configured === true || trialList.length > 0 ? (
      <SettingsTabs
        items={CONTENT_SUBSECTIONS.map((item) => {
          // 印の優先順位は 実行中 > 同期未確認 > 新着結果（`tabIndicator` が 1 箇所で決める）
          const indicator = tabIndicator({
            label: item.label,
            running: trialList.some(
              (trial) => trialKindSubsection(trial.kind) === item.subsection && trial.state === "running",
            ),
            unsynced: item.subsection === "speech" && !speechSynced,
            newResult: contentTrials.newResults.includes(item.subsection),
          });
          return {
            ...item,
            mark: indicator.dot === "warn",
            accentMark: indicator.dot === "accent",
            ariaLabel: indicator.ariaLabel ?? undefined,
          };
        })}
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
      caption="画像・音声・BGMの生成に使う OpenRouter のAPIキーとモデルを確認・設定します。"
      // タブが無い（未設定 / 取得前）間も取り直せるよう、面のツールバーは常に出す
      toolbar={
        <TabToolbar
          actions={
            <ReloadButton
              onClick={() => {
                void reload();
                // 試行の一覧も同じ面の操作として取り直す（取得中の試行はポーリングが拾う）
                void contentTrials.reload();
              }}
              disabled={reloading}
            >
              再読み込み
            </ReloadButton>
          }
        />
      }
      tabs={tabs}
      // 注記は出どころで分ける。試行の注記をここへ重ねると、消えない試行の注記が設定の失敗を隠す
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
          onSetEnabled={async (enabled) => {
            const saved = await setEnabled(enabled);
            // 保存できたときだけ取り直す（失敗時は旧い一覧のままでも実害が無い）
            if (saved) void refreshToolCatalog?.();
            return saved;
          }}
          onSaveKey={saveKey}
          onDeleteKey={removeKey}
          onSaveSelection={saveSelection}
          onRefreshCatalog={refreshCatalog}
          onSaveSpeech={saveSpeech}
          onRefreshSpeechCatalog={refreshSpeechCatalog}
          speechSynced={speechSynced}
          trials={contentTrials.trials}
          trialDetail={contentTrials.detail}
          trialHasMore={contentTrials.hasMore}
          trialLoadingMore={contentTrials.loadingMore}
          onSelectTrial={contentTrials.selectTrial}
          onLoadTrial={contentTrials.loadTrialDetail}
          onLoadMoreTrials={contentTrials.loadMore}
          trialArtifactUsage={contentTrials.artifactUsage}
          trialNote={contentTrials.note}
          trialKeyEpoch={trialKeyEpoch}
          trialBusy={contentTrials.busy}
          onStartTrial={contentTrials.start}
          onCancelTrial={contentTrials.cancel}
          onDeleteTrial={contentTrials.remove}
          onDeleteAllTrials={contentTrials.removeAll}
        />
      ) : (
        <SettingsPlaceholder label="コンテンツ生成の設定" note={note} />
      )}
    </SettingsPageLayout>
  );
}
