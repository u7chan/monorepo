import { useState } from "react";
import {
  imageCatalogNotice,
  imageCostNotice,
  hiddenImageModelCount,
  imageModelVisibilityNotice,
  imagePriceDisplay,
  visibleImageModelOptions,
  CONTENT_IMAGE_PROVIDER_HEADING,
  IMAGE_DEFAULT_NONE_LABEL,
  IMAGE_DEFAULT_NOTE,
  IMAGE_PROVIDER_OPTIONS,
  contentImageProviderLabel,
  imageAuthBadge,
  imageAuthNotice,
  imageDefaultClearSelection,
  imageDefaultsScreen,
  imageModelSectionVisible,
  imageModelOptions,
  imageModelPickerRows,
  imageModelSelection,
  imageModelValue,
  imageScreenModel,
  imageSelectionSaveDisabled,
  type ImageModelSort,
  SPEECH_NEEDS_OPENROUTER_KEY_NOTE,
  contentProviderId,
  contentProviderLabel,
  speechCatalogNotice,
  speechSaveDisabled,
  speechScreenSelection,
  speechSelection,
  type ImageDefaultsDraft,
  type SpeechScreenSelection,
  type ContentSavingAction,
} from "../../lib/contentSettings";
import {
  EMPTY_SPEECH_TRIAL_DRAFT,
  bgmTrialRequest,
  imageTrialDraftOf,
  imageTrialRequest,
  speechTrialDraftOf,
  speechTrialRequest,
  trialByteSizeLabel,
  trialCapacityWarningNote,
  trialStorageNote,
} from "../../lib/contentTrials";
import {
  imageModelParameterDeclarations,
  pruneImageTrialParameters,
  type ImageParameterDraft,
} from "../../lib/imageParameters";
import { cn } from "../../lib/cn";
import type { ContentSubsection } from "../../lib/settingsNav";
import type {
  ContentSettingsResponse,
  ContentTrial,
  ImageGenerationProvider,
  ContentTrialSummary,
  ContentTrialArtifactUsageValue,
  ContentTrialArtifactWarningValue,
  CreateContentTrialBody,
  UpdateContentCostBody,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../../types";
import { CollapsibleNotice } from "../CollapsibleNotice";
import { CatalogRefreshButton } from "./CatalogRefreshButton";
import { Fold } from "../Fold";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, GearIcon, TrashIcon } from "../icons";
import { ProviderIcon } from "../ProviderIcon";
import { SegmentedControl } from "../SegmentedControl";
import { SelectField } from "../SelectField";
import { SelectMenu, type SelectMenuOption } from "../SelectMenu";
import { ToggleSwitch } from "../ToggleSwitch";
import { MetaChip } from "../model-settings/MetaChip";
import { ProviderBadgeTag } from "../model-settings/ProviderBadgeTag";
import { EvidenceLine, ImageTrialSection } from "./ImageTrialSection";
import { BgmTrialSection } from "./BgmTrialSection";
import { SpeechTrialSection } from "./SpeechTrialSection";
import { SpeechVoiceOptions } from "./SpeechVoiceOptions";
import { TrialHistoryTab } from "./TrialHistoryTab";

export type ContentSettingsTabProps = {
  settings: ContentSettingsResponse;
  /** URL が決める面。既定は画像生成 */
  contentSubsection: ContentSubsection;
  /** 一覧と詳細を 1 画面ずつ出す（履歴タブだけが使う） */
  singleColumn?: boolean;
  /** 実行中の操作。null なら操作なし */
  saving: ContentSavingAction | null;
  /** 画像の生成元（OpenRouter / Codex）を切り替える。キーもモデルも伴わない */
  onSaveImageProvider: (provider: ImageGenerationProvider) => Promise<boolean>;
  onSaveSelection: (input: UpdateContentImageBody) => Promise<boolean>;
  onSaveSpeech: (input: UpdateContentSpeechBody) => Promise<boolean>;
  /** コストマスタの接続先とトグル。保存時に取得しない */
  onSaveCost: (input: UpdateContentCostBody) => Promise<boolean>;
  /**
   * 上流からモデル一覧と価格を取り直す 1 操作。一覧を持つ面（画像 / 音声）だけに置くので、
   * 帯ではなく各面のモデル節へ渡す
   */
  onRefreshCatalog: () => void;
  /** タブを切り替える（履歴への導線と、履歴から生成タブへ戻す導線） */
  onSelectContentSubsection?: (subsection: ContentSubsection) => void;
  /** 試行の一覧（要約。取得前は null）。表示する種別はタブが決める */
  trials: readonly ContentTrialSummary[] | null;
  /** 選択中の試行の全文（取得中は null） */
  trialDetail: ContentTrial | null;
  /** 続きのページがあるか */
  trialHasMore: boolean;
  trialLoadingMore: boolean;
  /** 選択行を画面へ知らせる（全文の取得は画面が行う） */
  onSelectTrial: (id: string | null) => void;
  /** 履歴の行の全文を取る（直近の結果の表示・再実行・この内容で編集） */
  onLoadTrial: (id: string) => Promise<ContentTrial | null>;
  /** 続きのページを読む */
  onLoadMoreTrials: () => Promise<boolean>;
  /** 保存容量（`succeeded` + 保存済みだけ）。3 タブの合計で、履歴の面に出す */
  trialArtifactUsage: ContentTrialArtifactUsageValue;
  /** 保存容量の警告。しきい値は一覧の応答が持ち、返さない間は null（警告を出さない） */
  trialArtifactWarning: ContentTrialArtifactWarningValue | null;
  /** 試行の操作（開始 / 中断 / 削除 / 一覧の取得失敗）の注記。試行の面の中だけに出す */
  trialNote: { text: string; error: boolean } | null;
  /** 現在のキー世代。証拠は現在のキーと選択中のモデルの実績だけを数える */
  trialKeyEpoch: number;
  /** 試行の操作。`saving` とは別の軸で、試行中も設定の保存は塞がない */
  trialBusy: boolean;
  onStartTrial: (input: CreateContentTrialBody) => Promise<boolean>;
  onCancelTrial: (id: string) => Promise<boolean>;
  onDeleteTrial: (id: string) => Promise<boolean>;
  /** 種別ごとの全削除。履歴タブは種別を省略して全種別を消せる */
  onDeleteAllTrials: (kind?: ContentTrial["kind"]) => Promise<boolean>;
};

/**
 * 設定 → コンテンツ生成の本文。生成タブは「タブ固有の設定（モデル・ボイス・既定）」と
 * 「設定に反映しない 1 回の試行 + 直近の結果」だけを持ち、履歴は専用のタブ（`TrialHistoryTab`）へ分ける。
 * 有効 / 無効とAPIキーはアプリ全体（3 種別共通）の設定なので、この本文ではなくページの帯が持つ。
 * `PUT /api/settings/content/image` と `.../speech` は行が無いと 400 のため、モデル選択はキー保存に成功してから現れる。
 */
export function ContentSettingsTab({
  settings,
  contentSubsection,
  singleColumn = false,
  saving,
  onSaveImageProvider,
  onSaveSelection,
  onSaveSpeech,
  onSaveCost,
  onRefreshCatalog,
  onSelectContentSubsection,
  trials,
  trialDetail,
  trialHasMore,
  trialLoadingMore,
  onSelectTrial,
  onLoadTrial,
  onLoadMoreTrials,
  trialArtifactUsage,
  trialArtifactWarning,
  trialNote,
  trialKeyEpoch,
  trialBusy,
  onStartTrial,
  onCancelTrial,
  onDeleteTrial,
  onDeleteAllTrials,
}: ContentSettingsTabProps) {
  // 面の下書きはこの画面が持ち続ける。面をタブで出し分けても unmount しないため、未保存の選択を失わない
  const [imageDraft, setImageDraft] = useState<string | null>(null);
  // 既定のパラメータの下書きも面を切り替えて失わないよう、この画面が持つ（モデルごとに組で持つ）
  const [imageDefaultsDraft, setImageDefaultsDraft] = useState<ImageDefaultsDraft | null>(null);
  const [speechDraft, setSpeechDraft] = useState<SpeechDraft>(EMPTY_SPEECH_DRAFT);
  // コストURLとトグルは [保存] 1 回で送る。null はサーバー値へ追随する
  const [costDraft, setCostDraft] = useState<{ enabled: boolean; url: string } | null>(null);
  // 試行のプロンプトは保存しない（履歴にだけ残す）。面を切り替えても失わないよう、この画面が持つ
  const [trialPrompt, setTrialPrompt] = useState("");
  // 画像の生成パラメータも同じ扱い。宣言に無いキーはモデルの切替でここから落とす
  const [trialParameters, setTrialParameters] = useState<ImageParameterDraft>({});
  // 音声の試行の本文・演技指示・話速も同じ扱い（保存値へ書き戻さない）
  const [speechTrialDraft, setSpeechTrialDraft] = useState(EMPTY_SPEECH_TRIAL_DRAFT);
  // BGM の試行のプロンプトも保存しない（履歴にだけ残す）
  const [bgmTrialPrompt, setBgmTrialPrompt] = useState("");
  // 証拠の相対表記は画面を開いた時刻で固定する（毎秒の再描画を持ち込まない）
  const [trialNow] = useState(() => Date.now());
  // 設定は既定で畳む。生成タブを「設定 + その場の 1 回」に保ち、変えるときだけ開く
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 画面に出ているモデル。モデル選択・試行の開始・証拠はこの 1 つを使う（保存前でも画面の値で試す）
  const screenModel = imageScreenModel({ draft: imageDraft, savedModel: imageModelValue(settings) });
  // 音声タブのモデル / ボイスも画面の値（下書き優先）。未設定でも履歴を出すため、タブの外側で解決する
  const speechSelectionOfScreen = speechScreenSelection(settings, speechDraft);
  const busy = saving !== null;
  const capacityWarning = trialCapacityWarningNote(trialArtifactWarning);
  // モデルを切り替えたら、新しい宣言に無いキーを下書きから落とす（隠れた値が要求に残ると 400 になる）。
  // 落とすのは画面の state だけで、保存値には触らない
  const trialParameterDeclarations = imageModelParameterDeclarations(settings.image.models, screenModel);
  const keptTrialParameters = pruneImageTrialParameters(trialParameterDeclarations, trialParameters);
  if (keptTrialParameters !== trialParameters) setTrialParameters(keptTrialParameters);

  // 未設定へ戻ったら下書きを捨てる。面の unmount で消えていた挙動を持ち上げた側で明示的に保つ
  if (
    !settings.configured &&
    (imageDraft !== null || imageDefaultsDraft !== null || speechDraft.model !== null || speechDraft.voice !== null)
  ) {
    setImageDraft(null);
    setImageDefaultsDraft(null);
    setSpeechDraft(EMPTY_SPEECH_DRAFT);
  }
  // キーを消したら設定パネルも閉じる（開いたままの空のフォームを残さない）
  if (!settings.configured && settingsOpen) setSettingsOpen(false);

  // 試行の結果を既定へ上げる。保存できたら下書きを捨て、画面を保存値へ追随させる（未保存表示を残さない）
  const saveTrialModel = async (input: UpdateContentImageBody): Promise<boolean> => {
    if (!(await onSaveSelection(input))) return false;
    setImageDraft(null);
    setImageDefaultsDraft(null);
    return true;
  };

  const saveTrialSpeech = async (input: UpdateContentSpeechBody): Promise<boolean> => {
    if (!(await onSaveSpeech(input))) return false;
    setSpeechDraft(EMPTY_SPEECH_DRAFT);
    return true;
  };

  /** 履歴の「この内容で編集」。全文を下書きへ戻して、その種別の生成タブを開く */
  const prefillTrial = (trial: ContentTrial): void => {
    if (trial.kind === "image") {
      const draft = imageTrialDraftOf(trial);
      setImageDraft(trial.model);
      setTrialPrompt(draft.prompt);
      setTrialParameters(draft.parameters);
    } else if (trial.kind === "speech") {
      setSpeechDraft({ model: trial.model, voice: trial.voice ?? "" });
      setSpeechTrialDraft(speechTrialDraftOf(trial));
    } else {
      setBgmTrialPrompt(trial.prompt);
    }
    onSelectContentSubsection?.(trial.kind);
  };

  /** 履歴の「もう一度生成」。確認のうえ、保存済みの結果を再利用せず新しい試行として課金する */
  const anotherTake = async (trial: ContentTrial): Promise<boolean> => {
    if (trial.kind === "image") {
      return onStartTrial(
        imageTrialRequest({
          model: trial.model,
          prompt: trial.prompt,
          parameters: trial.parameters ?? undefined,
          origin: "another-take",
        }),
      );
    }
    if (trial.kind === "speech") {
      const request = speechTrialRequest({
        draft: speechTrialDraftOf(trial),
        model: trial.model,
        voice: trial.voice ?? "",
        origin: "another-take",
      });
      if (!request.ok) throw new Error(request.error);
      return onStartTrial(request.input);
    }
    const request = bgmTrialRequest({ prompt: trial.prompt, model: settings.bgm.model ?? "", origin: "another-take" });
    if (!request.ok) throw new Error(request.error);
    return onStartTrial(request.input);
  };

  // 履歴タブは生成の設定を持たない。設定の保存中でも履歴は読める（削除と再生成だけが trialBusy に従う）
  if (contentSubsection === "history") {
    return (
      <TrialHistoryTab
        settings={settings}
        singleColumn={singleColumn}
        trials={trials}
        detail={trialDetail}
        hasMore={trialHasMore}
        loadingMore={trialLoadingMore}
        keyEpoch={trialKeyEpoch}
        artifactUsage={trialArtifactUsage}
        artifactWarning={trialArtifactWarning}
        note={trialNote}
        busy={trialBusy}
        onSelect={onSelectTrial}
        onLoadTrial={onLoadTrial}
        onLoadMore={onLoadMoreTrials}
        onDelete={onDeleteTrial}
        onDeleteAll={onDeleteAllTrials}
        onPrefill={prefillTrial}
        onAnotherTake={anotherTake}
      />
    );
  }

  const providerName = contentProviderLabel(settings.provider);
  const imageProvider = settings.image.provider;
  // 設定は既定で畳む。タブ固有の設定（モデル・ボイス・既定）だけを入れ、
  // アプリ全体の有効 / 無効とAPIキーはページの帯が持つ
  const tabSettings =
    contentSubsection === "image" ? (
      // Codex は画像モデルを選ばないため、画像タブでは何も出さない（BGM の欄へ落とさない）
      imageModelSectionVisible(imageProvider) ? (
        <ImageModelSection
          settings={settings}
          busy={busy}
          selectedModel={screenModel}
          onChangeDraft={setImageDraft}
          defaultsDraft={imageDefaultsDraft}
          onChangeDefaultsDraft={setImageDefaultsDraft}
          onSave={onSaveSelection}
          costDraft={costDraft}
          onChangeCostDraft={setCostDraft}
          onSaveCost={onSaveCost}
          catalogRefreshing={saving === "catalog"}
          onRefreshCatalog={onRefreshCatalog}
          trials={trials}
          trialKeyEpoch={trialKeyEpoch}
          trialNow={trialNow}
        />
      ) : null
    ) : contentSubsection === "speech" ? (
      <SpeechModelSection
        settings={settings}
        busy={busy}
        draft={speechDraft}
        onChangeDraft={setSpeechDraft}
        onSave={onSaveSpeech}
        catalogRefreshing={saving === "catalog"}
        onRefreshCatalog={onRefreshCatalog}
        selection={speechSelectionOfScreen}
        trials={trials}
        keyEpoch={trialKeyEpoch}
        trialNow={trialNow}
      />
    ) : (
      <BgmModelSection settings={settings} trials={trials} keyEpoch={trialKeyEpoch} now={trialNow} />
    );
  // 要約はタブ固有の値だけにする（有効 / 無効とキーは帯が常に出している）
  const settingsSummary =
    contentSubsection === "image"
      ? imageModelValue(settings) || "モデル未選択"
      : contentSubsection === "speech"
        ? `${speechSelectionOfScreen.selectedModel}${
            speechSelectionOfScreen.selectedVoice === "" ? "" : ` · ${speechSelectionOfScreen.selectedVoice}`
          }`
        : (settings.bgm.model ?? "モデル未取得");

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {/* このタブがどの provider の設定かを最初に示す。provider が増えたら settings.provider に追随する。
            件数と一覧の出どころはプロバイダータブと同じチップで揃える（キーの状態は帯が持つ） */}
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <ProviderIcon provider={contentProviderId(settings.provider)} name={providerName} variant="heading" />
          <h2 className="text-md font-semibold text-ink-strong">{providerName}</h2>
          <code className="text-2xs text-ink-ghost">{contentProviderId(settings.provider)}</code>
          <MetaChip>画像 {settings.image.models.length}</MetaChip>
          <MetaChip>音声 {settings.speech.models.length}</MetaChip>
        </section>
        <SecurityNotice />

        {/* 生成元はキー未設定でも選べるよう、設定パネルの外に出す（Codex はAPIキーを使わない） */}
        {contentSubsection === "image" ? (
          <ImageProviderSection
            settings={settings}
            busy={busy}
            onSave={onSaveImageProvider}
            onSaved={() => setImageDraft(null)}
          />
        ) : null}

        {/* 設定は要約 1 行を既定にし、変えるときだけ開く。生成と結果を同じ画面に収める。
            開閉は高さの遷移 (Fold) で見せる。中身は閉じている間も残す: 選択の下書きを
            開閉のたびに捨てない (inert でフォーカスと読み上げの対象からは外す)。
            入れるものが無い面（Codex の画像タブ）では畳みごと出さない */}
        {settings.configured && tabSettings !== null ? (
          <section className="rounded-lg border border-line bg-raised">
            <button
              type="button"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
              className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent-wash text-accent-text">
                <GearIcon />
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-2xs font-semibold tracking-label text-ink-faint uppercase">設定</span>
                <span className="truncate text-xs text-ink" title={settingsSummary}>
                  {settingsSummary}
                </span>
              </span>
              <span className="text-2xs text-ink-muted">{settingsOpen ? "閉じる" : "変更"}</span>
              <span className={cn("shrink-0 text-ink-faint transition-transform", settingsOpen && "rotate-180")}>
                <ChevronDownIcon />
              </span>
            </button>
            <Fold open={settingsOpen} keepMounted>
              <div className="grid gap-3 border-t border-line px-3 py-3">{tabSettings}</div>
            </Fold>
          </section>
        ) : null}

        {contentSubsection === "image" ? (
          <ImageTrialSection
            settings={settings}
            model={screenModel}
            trials={trials}
            keyEpoch={trialKeyEpoch}
            note={trialNote}
            busy={trialBusy}
            settingsBusy={busy}
            onMakeDefault={saveTrialModel}
            prompt={trialPrompt}
            onChangePrompt={setTrialPrompt}
            parameters={keptTrialParameters}
            onChangeParameters={setTrialParameters}
            onStart={onStartTrial}
            onCancel={onCancelTrial}
            onDelete={onDeleteTrial}
            onLoadTrial={onLoadTrial}
          />
        ) : contentSubsection === "speech" ? (
          <SpeechTrialSection
            settings={settings}
            model={speechSelectionOfScreen.selectedModel}
            voice={speechSelectionOfScreen.selectedVoice}
            trials={trials}
            keyEpoch={trialKeyEpoch}
            note={trialNote}
            busy={trialBusy}
            settingsBusy={busy}
            onMakeDefault={saveTrialSpeech}
            draft={speechTrialDraft}
            onChangeDraft={setSpeechTrialDraft}
            onStart={onStartTrial}
            onCancel={onCancelTrial}
            onDelete={onDeleteTrial}
            onLoadTrial={onLoadTrial}
          />
        ) : (
          <BgmTrialSection
            settings={settings}
            model={settings.bgm.model ?? ""}
            trials={trials}
            keyEpoch={trialKeyEpoch}
            note={trialNote}
            busy={trialBusy}
            prompt={bgmTrialPrompt}
            onChangePrompt={setBgmTrialPrompt}
            onStart={onStartTrial}
            onCancel={onCancelTrial}
            onDelete={onDeleteTrial}
            onLoadTrial={onLoadTrial}
          />
        )}

        {/* 履歴は専用のタブへ。件数はこの種別の読み込み済みの数、容量は 3 種別の合計 */}
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 text-left"
          onClick={() => onSelectContentSubsection?.("history")}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-wash text-accent-text">
            <ArrowRightIcon />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-xs font-semibold text-ink-strong">履歴を見る</span>
            <span className="truncate text-2xs text-ink-faint" title={trialStorageNote(trialArtifactUsage)}>
              この種別の履歴 {trials?.length ?? 0} 件 · 保存済み {trialArtifactUsage.count} 件 ·{" "}
              {trialByteSizeLabel(trialArtifactUsage.bytes)} · 画像 / 音声 / BGM をまとめて見る
            </span>
          </span>
          <span className="btn-quiet shrink-0">すべて見る</span>
        </button>
        {capacityWarning === null ? null : (
          <p role="status" className="text-2xs leading-relaxed break-words text-warn">
            {capacityWarning}
          </p>
        )}

        <section className="grid gap-1 border-t border-line pt-3 text-2xs leading-relaxed text-ink-muted">
          <p>
            <code>generate_image</code>・<code>generate_speech</code>・<code>generate_bgm</code> は、 画面上部の [有効]
            スイッチでまとめて止まります（OFF は保存した瞬間から
            <strong>既存のセッション</strong>にも次の呼び出しから効きます。ON に戻したとき、OFF の間に作った
            会話にはツールが無いため新しい会話が必要です。キーと選択は残ります）。
          </p>
          <p>
            保存したキーは<strong>新しい会話</strong>
            から使えます（ツール一覧はセッション作成時に固定されます）。削除しても既存の会話にはツールが残り、実行時にキー無効エラーになります。
          </p>
          <p>
            生成物はセッションの作業フォルダの <code>generated/</code> に保存され、チャットの画像 /
            音声としてプレビューできます。
          </p>
          <p>
            生成済み画像や添付画像を編集に使うと、その画像は外部の provider
            へ無変換（埋め込みメタデータを含む）で送信されます。
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * 画像の生成元。キー未設定でも選べるよう、設定パネルの外に出す（Codex はAPIキーを使わない）。
 * 認証の有無は保存値を読んだ結果（`settings.image.auth`）を出すだけで、この画面から解決しない。
 */
function ImageProviderSection({
  settings,
  busy,
  onSave,
  onSaved,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  onSave: (provider: ImageGenerationProvider) => Promise<boolean>;
  onSaved: () => void;
}) {
  const current = settings.image.provider;
  const notice = imageAuthNotice(settings);
  return (
    <section className="grid gap-2 rounded-lg border border-line bg-raised px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
          {CONTENT_IMAGE_PROVIDER_HEADING}
        </h3>
        <ProviderBadgeTag badge={imageAuthBadge(settings.image.auth)} />
        <span className="text-2xs text-ink-ghost">{contentImageProviderLabel(current)}</span>
      </div>
      <div role="radiogroup" aria-label={CONTENT_IMAGE_PROVIDER_HEADING} className="grid gap-1.5">
        {IMAGE_PROVIDER_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2",
              option.value === current ? "border-accent/60 bg-soft" : "border-line bg-base",
              busy ? "opacity-60" : null,
            )}
          >
            <input
              type="radio"
              name="content-image-provider"
              className="mt-0.5"
              value={option.value}
              checked={option.value === current}
              disabled={busy}
              onChange={() => {
                if (option.value === current) return;
                void onSave(option.value).then((saved) => {
                  if (saved) onSaved();
                });
              }}
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="text-xs font-semibold text-ink-strong">{option.label}</span>
              <span className="text-2xs leading-relaxed text-ink-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      {notice === null ? null : (
        <p
          role="status"
          className="rounded border border-warn/40 bg-base px-2 py-1.5 text-2xs leading-relaxed text-warn"
        >
          {notice}
        </p>
      )}
      {current === "codex" ? (
        <p className="text-2xs leading-relaxed text-ink-muted">{SPEECH_NEEDS_OPENROUTER_KEY_NOTE}</p>
      ) : null}
      <p className="text-2xs leading-relaxed text-ink-muted">
        生成元を切り替えても、他方のキーとモデルは残ります。切り替えは保存した瞬間から
        <strong>既存の会話</strong>
        の次の呼び出しにも効きます（未設定から有効にしたときだけ、ツールを持たない会話には新しい会話が必要です）。
      </p>
    </section>
  );
}

/** 音声のモデルとボイスの下書き。`null` は保存値へ追随する */
type SpeechDraft = { model: string | null; voice: string | null };

const EMPTY_SPEECH_DRAFT: SpeechDraft = { model: null, voice: null };

/**
 * 音楽（BGM）の保存される設定。モデルは Issue の非ゴールで選ばせないため、読取専用の 1 行と証拠だけを出し、
 * 入力と結果は試行の面（`BgmTrialSection`）へ置く。
 */
function BgmModelSection({
  settings,
  trials,
  keyEpoch,
  now,
}: {
  settings: ContentSettingsResponse;
  trials: readonly ContentTrialSummary[] | null;
  keyEpoch: number;
  now: number;
}) {
  return (
    <section className="grid min-w-0 gap-1.5 border-t border-line pt-3">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">保存される設定</h3>
      <label className="grid min-w-0 gap-1.5 text-2xs text-ink-muted">
        固定モデル（変更不可）
        <input
          className="field min-w-0 text-xs"
          aria-label="BGM生成の固定モデル"
          readOnly
          value={settings.bgm.model ?? ""}
        />
      </label>
      {/* キーの有効性は緑のバッジにせず、現在のキー世代の実績だけを証拠として出す */}
      <EvidenceLine trials={trials} model={settings.bgm.model ?? ""} keyEpoch={keyEpoch} now={now} />
      <p className="text-2xs leading-relaxed text-ink-muted">
        モデル仕様では{settings.bgm.expectedDurationSeconds}秒のクリップを{settings.bgm.format.toUpperCase()}
        で生成します（実測の尺ではありません）。生成は課金対象で、プロンプトをOpenRouterと生成プロバイダーへ外部送信します。
      </p>
      <p className="text-2xs leading-relaxed text-ink-muted">
        ボーカルなし・正確なBPMや尺・シームレスループは保証しません。失敗や中断でも課金される可能性があるため、自動で再生成しません。
      </p>
    </section>
  );
}

/**
 * コストマスタの接続先。価格は手動の [カタログ更新] のときだけ取りに行く。未設定でも従来どおり動くため、
 * OFF の間は URL を残したまま入力欄だけを非活性にする。
 */
function ContentCostSection({
  settings,
  busy,
  draft,
  onChangeDraft,
  onSave,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  draft: { enabled: boolean; url: string } | null;
  onChangeDraft: (draft: { enabled: boolean; url: string } | null) => void;
  onSave: (input: UpdateContentCostBody) => Promise<boolean>;
}) {
  const current = draft ?? { enabled: settings.image.cost.enabled, url: settings.image.cost.url ?? "" };
  const dirty = draft !== null;

  const submit = async () => {
    if (await onSave(current)) onChangeDraft(null);
  };

  return (
    <section className="grid gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">コスト表示</div>
          <p className="mt-0.5 text-xs text-ink">モデルの価格と「一覧に出すか」を任意のコストマスタから写します。</p>
        </div>
        <ToggleSwitch
          checked={current.enabled}
          label={current.enabled ? "ON" : "OFF"}
          disabled={busy}
          onChange={(enabled) => onChangeDraft({ ...current, enabled })}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-xs"
          type="url"
          inputMode="url"
          value={current.url}
          placeholder="https://cost-master.example.com/api/models"
          aria-label="コストマスタのURL"
          autoComplete="off"
          spellCheck={false}
          disabled={busy || !current.enabled}
          onChange={(event) => onChangeDraft({ ...current, url: event.currentTarget.value })}
        />
        <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => void submit()}>
          <CheckIcon />
          保存
        </button>
      </div>
      <p className="text-2xs leading-relaxed break-words text-ink-muted">
        {current.enabled
          ? "手動の [カタログ更新] のときだけ取得します（起動時・定期・再読み込みでは取りに行きません）。"
          : "OFF の間は取得も価格表示もしません。URL は保存したまま残ります。"}{" "}
        未設定なら価格は表示されず、モデルの選択・保存・試行は今までどおり動きます。
      </p>
    </section>
  );
}

/** モデル一覧の並び替え。見出しの軸も切り替わる（ベンダー / 価格の単位） */
const IMAGE_MODEL_SORT_ITEMS = [
  { value: "vendor", label: "ベンダー" },
  { value: "price", label: "価格" },
] as const satisfies readonly { value: ImageModelSort; label: string }[];

/** モデル選択と、そのモデルの既定のパラメータ。[保存] はモデルとパラメータを 1 回の PUT で送る */
function ImageModelSection({
  settings,
  busy,
  selectedModel,
  onChangeDraft,
  defaultsDraft,
  onChangeDefaultsDraft,
  onSave,
  costDraft,
  onChangeCostDraft,
  onSaveCost,
  catalogRefreshing,
  onRefreshCatalog,
  trials,
  trialKeyEpoch,
  trialNow,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  /** 画面で選択中のモデル（下書き優先）。試行と証拠も同じ値を使う */
  selectedModel: string;
  onChangeDraft: (draft: string | null) => void;
  /** 既定のパラメータの下書き。編集したモデルと組で持つ */
  defaultsDraft: ImageDefaultsDraft | null;
  onChangeDefaultsDraft: (draft: ImageDefaultsDraft | null) => void;
  onSave: (input: UpdateContentImageBody) => Promise<boolean>;
  /** コストマスタの下書き。価格を出すのはこの面だけなので、共有カードではなくここへ置く */
  costDraft: { enabled: boolean; url: string } | null;
  onChangeCostDraft: (draft: { enabled: boolean; url: string } | null) => void;
  onSaveCost: (input: UpdateContentCostBody) => Promise<boolean>;
  /** [カタログ更新] の実行中。一覧と価格の取得は 1 本なので、帯ではなくこの面の状態で示す */
  catalogRefreshing: boolean;
  onRefreshCatalog: () => void;
  trials: readonly ContentTrialSummary[] | null;
  trialKeyEpoch: number;
  trialNow: number;
}) {
  // 解決（PUT 本文・既定の保存キー）は全件の一覧、描画は visible で絞った一覧を使う
  const options = imageModelOptions(settings);
  const choices = visibleImageModelOptions(settings);
  // 並び順は一覧の見え方だけの話なので、保存値とは別に画面が持つ
  const [modelSort, setModelSort] = useState<ImageModelSort>("vendor");
  const pickerOptions: SelectMenuOption<string>[] = imageModelPickerRows(choices, modelSort).map((row) => ({
    value: row.value,
    label: row.label,
    triggerLabel: row.fullLabel,
    // 価格不明は行にもトリガーにも出さない（選択中の価格は下のチップが警告付きで出す）
    detail: row.price === "--" ? undefined : row.price,
    group: row.group,
  }));
  const savedModel = imageModelValue(settings);
  const selectedEntry = settings.image.models.find((entry) => `${entry.provider}/${entry.id}` === selectedModel);
  const price = imagePriceDisplay(selectedEntry?.prices ?? []);
  const hiddenCount = hiddenImageModelCount(settings);
  const visibility = imageModelVisibilityNotice(settings);
  const cost = imageCostNotice(settings.image.cost);
  const defaults = imageDefaultsScreen(settings, selectedModel, defaultsDraft);
  const modelDirty = selectedModel !== savedModel;
  const dirty = modelDirty || defaults.dirty;

  const submit = async () => {
    if (!defaults.body.ok) return;
    const selection = imageModelSelection(options, selectedModel);
    if (!selection) return;
    // 編集が無ければ parameters を省く（値ありは置き換えなので、触っていない既定を送り直さない）
    const input = defaults.body.unchanged ? selection : { ...selection, parameters: defaults.body.parameters };
    if (!(await onSave(input))) return;
    onChangeDraft(null);
    onChangeDefaultsDraft(null);
  };

  // 解除は画面のモデルに対する 1 回の PUT。選んでいるモデルに保存済みの既定が無ければ押せない
  const clearDefaults = async () => {
    const input = imageDefaultClearSelection(options, selectedModel);
    if (!input) return;
    if (await onSave(input)) onChangeDefaultsDraft(null);
  };

  return (
    <section className="grid gap-1.5 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">保存される設定</h3>
        {dirty ? <span className="text-2xs text-warn">未保存</span> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SelectMenu
          label="コンテンツ生成のモデル"
          options={pickerOptions}
          value={selectedModel}
          disabled={busy}
          searchable
          searchPlaceholder="モデル名 / ベンダーで絞り込み"
          triggerClassName="min-w-0 flex-1"
          controls={
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint">並び順</span>
              <SegmentedControl
                items={IMAGE_MODEL_SORT_ITEMS}
                value={modelSort}
                onChange={setModelSort}
                ariaLabel="モデルの並び順"
              />
            </div>
          }
          onChange={(next) => onChangeDraft(next)}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={imageSelectionSaveDisabled({
            busy,
            modelDirty,
            defaultsDirty: defaults.dirty,
            invalid: !defaults.body.ok,
          })}
          onClick={() => void submit()}
        >
          <CheckIcon />
          保存
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <MetaChip tone={price.label === "--" ? "warn" : "muted"}>価格 {price.label}</MetaChip>
        {hiddenCount === 0 ? null : <MetaChip tone="muted">{`${hiddenCount} 件は一覧に出していません`}</MetaChip>}
        {cost === null ? null : <MetaChip tone={cost.tone}>{cost.text}</MetaChip>}
      </div>
      {selectedEntry?.note ? (
        <p className="text-2xs leading-relaxed break-words text-ink-muted">{selectedEntry.note}</p>
      ) : null}
      {price.note === null ? null : <p className="text-2xs leading-relaxed text-ink-muted">{price.note}</p>}
      {visibility === null ? null : (
        <p
          role="status"
          className="rounded border border-warn/40 bg-base px-2 py-1.5 text-2xs leading-relaxed text-warn"
        >
          {visibility.text}
        </p>
      )}
      {/* 既定はモデルの宣言に応じた欄だけを出す。宣言が無ければ「既定なし」だけを書く */}
      {defaults.fields.length === 0 ? null : (
        <div className="grid gap-2 sm:grid-cols-2">
          {defaults.fields.map((field) => {
            const value = defaults.values[field.name] ?? "";
            const set = (next: string) =>
              onChangeDefaultsDraft({ model: selectedModel, values: { ...defaults.values, [field.name]: next } });
            return (
              <label key={field.name} className="grid min-w-0 gap-1">
                <span className="text-2xs text-ink-muted">{field.name}</span>
                {field.kind === "enum" ? (
                  <SelectField
                    aria-label={`既定の ${field.name}`}
                    value={value}
                    disabled={busy}
                    onChange={(event) => set(event.currentTarget.value)}
                  >
                    <option value="">{IMAGE_DEFAULT_NONE_LABEL}</option>
                    {field.values.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </SelectField>
                ) : (
                  <input
                    className="field min-w-0 text-xs"
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    max={field.max}
                    value={value}
                    placeholder={IMAGE_DEFAULT_NONE_LABEL}
                    aria-label={`既定の ${field.name}`}
                    disabled={busy}
                    onChange={(event) => set(event.currentTarget.value)}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}
      {defaults.body.ok ? null : (
        <p role="alert" className="text-2xs break-words text-warn">
          {defaults.body.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-quiet"
          disabled={busy || defaults.clearDisabled}
          onClick={() => void clearDefaults()}
        >
          <TrashIcon />
          既定を解除
        </button>
        <p className="min-w-0 text-2xs leading-relaxed text-ink-muted">{IMAGE_DEFAULT_NOTE}</p>
      </div>
      {/* キーの有効性は緑のバッジにせず、現在のキー世代と選択中モデルの実績だけを証拠として出す */}
      <EvidenceLine trials={trials} model={selectedModel} keyEpoch={trialKeyEpoch} now={trialNow} />
      {/* 価格を出すのはこの面だけなので、コストマスタの接続先もここに置く（音声 / BGM には出さない） */}
      <ContentCostSection
        settings={settings}
        busy={busy}
        draft={costDraft}
        onChangeDraft={onChangeCostDraft}
        onSave={onSaveCost}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 段落のセマンティクスを残すため、チップ (span) は <p> の中に置く */}
        <p className="min-w-0">
          <MetaChip wrap tone={settings.image.catalogSource === "live" ? "muted" : "warn"}>
            {imageCatalogNotice(settings.image)}
          </MetaChip>
        </p>
        {/* 一覧の出どころを書いている行に、その一覧を取り直す操作を置く */}
        <CatalogRefreshButton refreshing={catalogRefreshing} disabled={busy} onClick={onRefreshCatalog} />
      </div>
    </section>
  );
}

/**
 * 音声のモデルとボイス。画像と同じ行（`content_settings`）の別の列で、生成のたびにツールが読み直す。
 * 宣言が無いモデルは空欄を許し、自由記述の入力欄へ切り替える（送らない場合は空のまま保存する）。
 */
function SpeechModelSection({
  settings,
  busy,
  draft,
  onChangeDraft,
  onSave,
  catalogRefreshing,
  onRefreshCatalog,
  selection,
  trials,
  keyEpoch,
  trialNow,
}: {
  settings: ContentSettingsResponse;
  busy: boolean;
  draft: SpeechDraft;
  onChangeDraft: (draft: SpeechDraft) => void;
  onSave: (input: UpdateContentSpeechBody) => Promise<boolean>;
  /** [カタログ更新] の実行中。音声の一覧も OpenRouter のカタログ由来なので、画像が Codex でも出す */
  catalogRefreshing: boolean;
  onRefreshCatalog: () => void;
  /** 画面のモデル / ボイス。保存フォーム・証拠・試行で同じ解決を使う */
  selection: SpeechScreenSelection;
  trials: readonly ContentTrialSummary[] | null;
  keyEpoch: number;
  trialNow: number;
}) {
  const { options, selectedModel, selectedOption, selectedVoice, textMode, dirty } = selection;

  const submit = async () => {
    const input = speechSelection(options, selectedModel, selectedVoice);
    if (!input) return;
    if (await onSave(input)) onChangeDraft(EMPTY_SPEECH_DRAFT);
  };

  return (
    <section className="grid gap-1.5 border-t border-line pt-3">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">保存される設定</h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SelectField
          wrapperClassName="min-w-0 flex-1"
          aria-label="音声生成のモデル"
          value={selectedModel}
          disabled={busy}
          onChange={(event) => onChangeDraft({ model: event.currentTarget.value, voice: null })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {textMode ? (
          <input
            className="field min-w-0 flex-1 text-xs"
            value={selectedVoice}
            aria-label="音声生成のボイス"
            placeholder="モデル既定（空欄のまま送ります）"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onChangeDraft({ ...draft, voice: event.currentTarget.value })}
          />
        ) : (
          <SelectField
            wrapperClassName="min-w-0 flex-1"
            aria-label="音声生成のボイス"
            value={selectedVoice}
            disabled={busy}
            onChange={(event) => onChangeDraft({ ...draft, voice: event.currentTarget.value })}
          >
            <SpeechVoiceOptions modelId={selectedModel} voices={selectedOption?.model?.voices} />
          </SelectField>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={speechSaveDisabled({ busy, dirty })}
          onClick={() => void submit()}
        >
          <CheckIcon />
          保存
        </button>
      </div>
      {/* キーの有効性は緑のバッジにせず、現在のキー世代と選択中のモデル / ボイスの実績だけを証拠として出す */}
      <EvidenceLine trials={trials} model={selectedModel} voice={selectedVoice} keyEpoch={keyEpoch} now={trialNow} />
      {/* 出力形式の選択 UI は持たない。形式は生成器が provider の応答から確定する（mp3 / wav） */}
      <p className="text-2xs leading-relaxed text-ink-muted">
        出力形式は選ばず、provider が返した形式（mp3 /
        wav）で保存します。読み上げる文章だけを渡し、演技指示は本文に書かせません。長文は分けて複数回呼ばせます。
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 段落のセマンティクスを残すため、チップ (span) は <p> の中に置く */}
        <p className="min-w-0">
          <MetaChip wrap tone={settings.speech.catalogSource === "live" ? "muted" : "warn"}>
            {speechCatalogNotice(settings.speech)}
          </MetaChip>
        </p>
        {/* 音声の一覧も同じカタログから来るので、一覧の出どころの行に取り直しを置く */}
        <CatalogRefreshButton refreshing={catalogRefreshing} disabled={busy} onClick={onRefreshCatalog} />
      </div>
    </section>
  );
}

/** キーを暗号化して保存することと、BFF を公開しない注意。詳細の上部に既定で畳んで出す */
function SecurityNotice() {
  return (
    <CollapsibleNotice summary="キーは暗号化して保存されます。ログインがないため公開しないでください。">
      <p>
        登録したキーは暗号化してアプリのデータベース（SQLite）へ保存され、再起動後も使われます。保存したキーは再表示しません。
        master key（U7AGENT_SECRET_MASTER_KEY）が未設定の間は、保存済みのキーを使えません。
      </p>
      <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
      <p>キーの有効性は保存時に確認しません。生成に失敗したときは、キーの誤りや残高不足の可能性があります。</p>
    </CollapsibleNotice>
  );
}
