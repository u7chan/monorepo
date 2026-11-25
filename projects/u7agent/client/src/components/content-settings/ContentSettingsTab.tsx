import { useState } from "react";
import {
  imageModelSectionVisible,
  imageModelValue,
  imageScreenModel,
  type ImageDefaultsDraft,
} from "../../lib/contentSettings/image";
import { speechScreenSelection } from "../../lib/contentSettings/speech";
import { contentProviderId, contentProviderLabel, type ContentSavingAction } from "../../lib/contentSettings/shared";
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
  ContentTrialSummary,
  ContentTrialArtifactUsageValue,
  ContentTrialArtifactWarningValue,
  CreateContentTrialBody,
  ImageGenerationProvider,
  UpdateContentImageBody,
  UpdateContentSpeechBody,
} from "../../types";
import { ArrowRightIcon, ChevronDownIcon, GearIcon } from "../icons";
import { Fold } from "../Fold";
import { MetaChip } from "../model-settings/MetaChip";
import { ProviderIcon } from "../ProviderIcon";
import { BgmModelSection } from "./BgmModelSection";
import { BgmTrialSection } from "./BgmTrialSection";
import { ImageModelSection } from "./ImageModelSection";
import { ImageProviderSection } from "./ImageProviderSection";
import { ImageTrialSection } from "./ImageTrialSection";
import { SecurityNotice } from "./SecurityNotice";
import { EMPTY_SPEECH_DRAFT, SpeechModelSection, type SpeechDraft } from "./SpeechModelSection";
import { SpeechTrialSection } from "./SpeechTrialSection";
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
