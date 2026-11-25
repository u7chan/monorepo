import { useState } from "react";
import {
  IMAGE_DEFAULT_NONE_LABEL,
  IMAGE_DEFAULT_NOTE,
  hiddenImageModelCount,
  imageCatalogNotice,
  imageDefaultClearSelection,
  imageDefaultsScreen,
  imageModelOptions,
  imageModelPickerRows,
  imageModelSelection,
  imageModelValue,
  imageModelVisibilityNotice,
  imagePriceDisplay,
  imageSelectionSaveDisabled,
  visibleImageModelOptions,
  type ImageDefaultsDraft,
  type ImageModelSort,
} from "../../lib/contentSettings/image";
import { costNotice } from "../../lib/contentSettings/shared";
import type { ContentSettingsResponse, ContentTrialSummary, UpdateContentImageBody } from "../../types";
import { CheckIcon, TrashIcon } from "../icons";
import { MetaChip } from "../model-settings/MetaChip";
import { SegmentedControl } from "../SegmentedControl";
import { SelectMenu, type SelectMenuOption } from "../SelectMenu";
import { CatalogRefreshButton } from "./CatalogRefreshButton";
import { EvidenceLine } from "./ImageTrialSection";
import { ImageParameterFields } from "./ImageParameterFields";

/** モデル一覧の並び替え。見出しの軸も切り替わる（ベンダー / 価格の単位） */
const IMAGE_MODEL_SORT_ITEMS = [
  { value: "vendor", label: "ベンダー" },
  { value: "price", label: "価格" },
] as const satisfies readonly { value: ImageModelSort; label: string }[];

/** モデル選択と、そのモデルの既定のパラメータ。[保存] はモデルとパラメータを 1 回の PUT で送る */
export function ImageModelSection({
  settings,
  busy,
  selectedModel,
  onChangeDraft,
  defaultsDraft,
  onChangeDefaultsDraft,
  onSave,
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
  const cost = costNotice(settings.cost);
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
        <ImageParameterFields
          fields={defaults.fields}
          values={defaults.values}
          onChange={(name, next) =>
            onChangeDefaultsDraft({ model: selectedModel, values: { ...defaults.values, [name]: next } })
          }
          disabled={busy}
          labelPrefix="既定の"
          emptyLabel={IMAGE_DEFAULT_NONE_LABEL}
        />
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
