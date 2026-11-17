import { useState } from "react";
import { useContentSettings, type ContentSettings } from "../hooks/useContentSettings";
import { useContentTrials, type ContentTrials } from "../hooks/useContentTrials";
import {
  contentKeyErrorNotice,
  contentKeyStatusBadge,
  contentProviderLabel,
  deleteContentKeyConfirmRequest,
  keyDraftAfterSave,
} from "../lib/contentSettings";
import { tabIndicator, trialKindSubsection } from "../lib/contentTrials";
import { CONTENT_SUBSECTIONS, DEFAULT_CONTENT_SUBSECTION, type ContentSubsection } from "../lib/settingsNav";
import { ContentSettingsTab } from "./content-settings/ContentSettingsTab";
import { ContentKeySection } from "./content-settings/ContentKeySection";
import { useConfirm } from "./ConfirmProvider";
import { ProviderBadgeTag } from "./model-settings/ProviderBadgeTag";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SettingsPlaceholder } from "./SettingsPlaceholder";
import { SettingsTabs } from "./SettingsTabs";
import { TabToolbar } from "./TabToolbar";
import { ToggleSwitch } from "./ToggleSwitch";

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
  // 未設定では履歴だけを見せる。タブを出すために一覧を種別で絞らない（設定済みならタブごとに絞る）。
  // 履歴タブは設定の有無に関係なく全種別をまとめて出す。
  const contentTrials = useContentTrials({
    activeSubsection: contentSubsection,
    kindScoped: contentSettings.settings?.configured === true && contentSubsection !== "history",
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
    saveKey,
    removeKey: removeKeyFromServer,
    saveImageProvider,
    saveSelection,
    saveSpeech,
    saveCost,
    refreshCatalog,
  } = contentSettings;
  // キーの入力は带の下に出し、[変更] で開く。未設定のときは最初から開けて、最初の 1 手を探させない
  const [apiKey, setApiKey] = useState("");
  const [keyOpenDraft, setKeyOpenDraft] = useState<boolean | null>(null);
  const confirm = useConfirm();
  const keyOpen = keyOpenDraft ?? settings?.configured === false;
  const providerName = settings === null ? "" : contentProviderLabel(settings.provider);
  const keyError = settings === null ? null : contentKeyErrorNotice(settings);

  const submitKey = async () => {
    setApiKey(keyDraftAfterSave(apiKey, await saveKey(apiKey)));
  };

  const removeKey = async () => {
    if (!(await confirm(deleteContentKeyConfirmRequest(providerName)))) return;
    // 削除できたときだけ入力を捨てる (失敗時に打ちかけの値を消さない)
    if (await removeKeyFromServer()) setApiKey("");
  };

  /** 有効 / 無効はアプリ全体（画像・音声・BGM 共通）の設定なので、タブではなく带に置く */
  const setEnabled = async (enabled: boolean): Promise<boolean> => {
    const saved = await contentSettings.setEnabled(enabled);
    // 保存できたときだけ取り直す（ツールの `available` が変わるため）
    if (saved) void refreshToolCatalog?.();
    return saved;
  };
  // 取得前は面の中身が無い。未設定でも試行の履歴があれば読めるようにタブを出す（新規生成だけを止める）
  const trialList = contentTrials.trials ?? [];
  // キーの保存 / 削除で世代が変わったら、一覧を取り直さなくても証拠と「旧キー」の判定を追随させる
  const trialKeyEpoch = settings?.keyEpoch ?? contentTrials.keyEpoch;
  const tabs =
    settings?.configured === true || trialList.length > 0 || contentSubsection === "history" ? (
      <SettingsTabs
        items={CONTENT_SUBSECTIONS.map((item) => {
          // 印の優先順位は 実行中 > 新着結果（`tabIndicator` が 1 箇所で決める）
          const indicator = tabIndicator({
            label: item.label,
            running: trialList.some(
              (trial) =>
                (item.subsection === "history" || trialKindSubsection(trial.kind) === item.subsection) &&
                trial.state === "running",
            ),
            // 履歴は全種別を 1 つの一覧に出すため、どの種別の新着でも 1 つの印にまとめる
            newResult:
              item.subsection === "history"
                ? contentTrials.newResults.length > 0
                : contentTrials.newResults.includes(item.subsection),
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
      caption={
        contentSubsection === "history"
          ? "画像・音声・BGM の試行をまとめて確認します。チャットの生成は含みません。"
          : "画像・音声・BGMの生成に使う OpenRouter のAPIキーとモデルを確認・設定します。"
      }
      // タブが無い（未設定 / 取得前）間も取り直せるよう、面のツールバーは常に出す。
      // 帯の左には、どのタブでも同じである「アプリ全体」の状態（有効 / 無効とキー）を置く。
      // タブ固有の設定は本文の「設定」に残し、同じ内容をタブごとに繰り返さない。
      // 帯に置く取り直しは [再読み込み] だけにする: 上流から取り直す [カタログ更新] は、
      // 一覧の出どころを書いている行（各タブのモデル節）に置き、一覧を持たない面には出さない
      toolbar={
        <div>
          <TabToolbar
            context={
              settings === null ? undefined : (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-2xs font-semibold tracking-label text-ink-faint uppercase">アプリ全体</span>
                  {/* 行が無い（未設定）間は保存先が無く、サーバーも 400 を返すため出さない */}
                  {settings.configured ? (
                    <ToggleSwitch
                      size="sm"
                      checked={settings.enabled}
                      label={settings.enabled ? "有効" : "無効"}
                      ariaLabel="コンテンツ生成を有効にする（画像・音声・BGM 共通）"
                      disabled={saving !== null}
                      onChange={(next) => void setEnabled(next)}
                    />
                  ) : null}
                  <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
                  <span className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-soft">
                    {providerName} キー
                    <ProviderBadgeTag badge={contentKeyStatusBadge(settings.keyStored, settings.keyAvailable)} />
                    <button
                      type="button"
                      className="link-quiet"
                      aria-expanded={keyOpen}
                      onClick={() => setKeyOpenDraft(!keyOpen)}
                    >
                      {keyOpen ? "閉じる" : settings.keyStored ? "変更" : "登録"}
                    </button>
                  </span>
                </div>
              )
            }
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
          {/* キーの入力は带の下に開く。開閉は高さを取るため、ヒントを読むだけの間は閉じておく */}
          {settings !== null && keyOpen ? (
            <div className="border-b border-line bg-soft px-4 py-2.5">
              {settings.runtimeAvailable ? null : (
                <p
                  role="alert"
                  className="mb-2 rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn"
                >
                  ランタイムが利用できないため、コンテンツ生成のAPIキーの登録・上書き・削除はできません。サーバーの起動ログを確認してください。
                </p>
              )}
              <ContentKeySection
                keyStored={settings.keyStored}
                apiKey={apiKey}
                busy={saving !== null}
                runtimeAvailable={settings.runtimeAvailable}
                providerName={providerName}
                onChange={setApiKey}
                onSubmit={submitKey}
                onRemove={removeKey}
              />
            </div>
          ) : null}
          {/* 状態の理由は、開かなくても読めるよう帯の直下に出す（タブを変えても同じ位置） */}
          {keyError === null ? null : (
            <p
              role="alert"
              className="border-b border-warn/40 bg-raised px-4 py-1.5 text-2xs leading-relaxed break-words text-warn"
            >
              {keyError}
            </p>
          )}
          {/* 無効の間は、モデルへ返る文言をどのタブでも同じ位置に出す（理由を探させない） */}
          {settings !== null && !settings.enabled ? (
            <p
              role="status"
              className="border-b border-warn/40 bg-raised px-4 py-1.5 text-2xs leading-relaxed break-words text-warn"
            >
              無効の間、モデルへはこの文言だけが返ります:
              <span className="text-ink">{settings.disabledMessage}</span>
            </p>
          ) : null}
        </div>
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
          singleColumn={singleColumn}
          saving={saving}
          onSaveImageProvider={async (provider) => {
            const saved = await saveImageProvider(provider);
            // 公開するツールが変わるため、保存できたときだけエージェントの一覧を取り直す
            if (saved) void refreshToolCatalog?.();
            return saved;
          }}
          onSaveSelection={saveSelection}
          onSaveSpeech={saveSpeech}
          onSaveCost={saveCost}
          onRefreshCatalog={() => void refreshCatalog()}
          trials={contentTrials.trials}
          onSelectContentSubsection={onSelectContentSubsection}
          trialDetail={contentTrials.detail}
          trialHasMore={contentTrials.hasMore}
          trialLoadingMore={contentTrials.loadingMore}
          onSelectTrial={contentTrials.selectTrial}
          onLoadTrial={contentTrials.loadTrialDetail}
          onLoadMoreTrials={contentTrials.loadMore}
          trialArtifactUsage={contentTrials.artifactUsage}
          trialArtifactWarning={contentTrials.artifactWarning}
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
