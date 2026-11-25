import {
  hiddenSpeechModelCount,
  speechCatalogNotice,
  speechModelVisibilityNotice,
  speechPriceDisplay,
  speechPriceSideLabel,
  speechSaveDisabled,
  speechSelection,
  visibleSpeechModelOptions,
  type SpeechScreenSelection,
} from "../../lib/contentSettings/speech";
import { costNotice } from "../../lib/contentSettings/shared";
import type { ContentSettingsResponse, ContentTrialSummary, UpdateContentSpeechBody } from "../../types";
import { CheckIcon } from "../icons";
import { MetaChip } from "../model-settings/MetaChip";
import { SelectField } from "../SelectField";
import { CatalogRefreshButton } from "./CatalogRefreshButton";
import { EvidenceLine } from "./ImageTrialSection";
import { SpeechVoiceOptions } from "./SpeechVoiceOptions";

/** 音声のモデルとボイスの下書き。`null` は保存値へ追随する */
export type SpeechDraft = { model: string | null; voice: string | null };

export const EMPTY_SPEECH_DRAFT: SpeechDraft = { model: null, voice: null };

/**
 * 音声のモデルとボイス。画像と同じ行（`content_settings`）の別の列で、生成のたびにツールが読み直す。
 * 宣言が無いモデルは空欄を許し、自由記述の入力欄へ切り替える（送らない場合は空のまま保存する）。
 */
export function SpeechModelSection({
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
  // 解決（PUT 本文）は全件、描画は visible で絞った一覧を使う
  const choices = visibleSpeechModelOptions(settings);
  const selectedEntry = settings.speech.models.find((entry) => entry.id === selectedModel);
  const price = speechPriceDisplay(selectedEntry?.prices ?? []);
  const hiddenCount = hiddenSpeechModelCount(settings);
  const visibility = speechModelVisibilityNotice(settings);
  const cost = costNotice(settings.cost);

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
          {choices.map((option) => (
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
      <div className="flex flex-wrap items-center gap-2">
        <MetaChip tone={price.primary === null ? "warn" : "muted"}>
          価格 {price.primary === null ? "--" : `${speechPriceSideLabel(price.primary.side)} ${price.primary.text}`}
        </MetaChip>
        {price.secondary === null ? null : (
          <MetaChip tone="muted">{`${speechPriceSideLabel(price.secondary.side)} ${price.secondary.text}`}</MetaChip>
        )}
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
