import { useCallback, useEffect, useId, useMemo } from "react";
import { effortChoices, effortLabel, type ComposerSettings } from "../../lib/composerSettings";
import { cn } from "../../lib/cn";
import { modelChoices, unavailableModelChoice } from "../../lib/modelChoices";
import {
  POPOVER_MARGIN,
  popoverAvailableHeight,
  popoverLeft,
  popoverOpensAbove,
  popoverTop,
  popoverWidth,
} from "../../lib/popoverPlacement";
import { usePopoverShell, type PopoverPlaceInput } from "../../hooks/usePopoverShell";
import type { ModelRef, ThinkingLevel } from "../../types";
import { SelectField } from "../SelectField";
import { ChevronDownIcon } from "../icons";
import { fieldLabelClass, fieldNameClass } from "./fieldStyles";

/** ポップアップの幅の上限 (px)。候補の選択肢と注意文が読める幅 */
const MODEL_EFFORT_PICKER_WIDTH = 320;

/**
 * コンポーザーの Model / Effort 切り替え。行に置くと開閉でコンポーザーが伸びるため popover (top layer)
 * に出し、位置は lib/popoverPlacement.ts が決める。開閉は native popover に任せ、常時 mount する。
 */
export function ModelEffortPicker({
  settings,
  singleColumn,
  open,
  onOpenChange,
  onChangeModel,
  onChangeThinkingLevel,
}: {
  settings: ComposerSettings;
  singleColumn: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
}) {
  const pickerId = useId();
  // 注意文は popover の中だけに出す。畳んでいるときはモデルが使えない警告だけを入力欄の下へ残す
  const notice = settings.modelWarning ?? settings.effortNotice;
  const label = settings.modelLabel ?? "未選択";
  // 操作が要る壊れ状態は、実効モデルが候補に無いときと未選択で同じ
  const warn = settings.modelWarning !== undefined || settings.modelLabel === undefined;
  const current = settings.effortLabel ? `${label} - ${settings.effortLabel}` : label;
  // 開いても選べるモデルが無い導線を残さない。実行中・設定変更中も開ける (中の select が無効のまま)
  const unavailable = settings.modelOptions.length === 0 && !settings.model;

  // 幅と高さの上限を先に確定させる: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
  const sizePicker = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    const above = popoverOpensAbove(anchor, viewport.height);
    popover.style.width = `${popoverWidth(MODEL_EFFORT_PICKER_WIDTH, viewport.width)}px`;
    popover.style.maxHeight = `${popoverAvailableHeight(anchor, viewport.height, above)}px`;
  }, []);

  const place = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    const anchor = trigger.getBoundingClientRect();
    const above = popoverOpensAbove(anchor, viewport.height);
    const width = popoverWidth(MODEL_EFFORT_PICKER_WIDTH, viewport.width);
    return {
      left: popoverLeft(anchor, width, viewport.width),
      top: popoverTop(anchor, popover.getBoundingClientRect().height, above, viewport.height),
    };
  }, []);

  // 開いた直後の焦点はトリガーに残す (そのまま Tab で中の select へ入る)。開閉は親が持ち、
  // 標準の close も `onOpenChange` で伝わる
  const { triggerProps, popoverProps, containerProps, close } = usePopoverShell(place, POPOVER_MARGIN, {
    reposition: ({ place: placeNow }) => placeNow(),
    exitOnBlur: ({ close: closeNow }) => closeNow(),
    size: sizePicker,
    // 開いた直後の焦点はトリガーに残す (そのまま Tab で中の select へ入る)
    openFocus: () => null,
    onOpenChange,
  });

  // 親から畳まれたとき (送信の成立) だけ閉じる。開くのはトリガーだけにする (設定変更の完了などの
  // 再描画で勝手に開き直さない)
  useEffect(() => {
    if (!open) close();
  }, [close, open]);

  return (
    // トリガーとポップアップを 1 つのフォーカス範囲として扱う (display: contents は行の flex 配置を変えない)
    <div className="contents" {...containerProps}>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pickerId}
        aria-label={`モデルと Effort の設定（${current}）`}
        title={settings.model}
        popoverTarget={pickerId}
        popoverTargetAction="toggle"
        disabled={unavailable}
        className={cn(
          "composer-model-trigger hover:text-accent-text focus-visible:text-accent-text",
          warn ? "text-warn" : open ? "text-accent-text" : "text-ink-faint",
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {settings.effortLabel ? <span className="shrink-0">{`- ${settings.effortLabel}`}</span> : null}
        {unavailable ? null : <ChevronDownIcon />}
      </button>

      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置と幅は place() が left / top / width / max-height を直接書く */}
      <div
        {...popoverProps}
        id={pickerId}
        popover="auto"
        role="dialog"
        aria-label="モデルと Effort"
        className="popover-panel fixed inset-auto m-0 scrollbar-thin overflow-y-auto rounded-lg border border-line bg-panel p-2.5 shadow-panel"
      >
        <div className="grid min-w-0 gap-2">
          <ModelEffortFields
            settings={settings}
            singleColumn={singleColumn}
            onChangeModel={onChangeModel}
            onChangeThinkingLevel={onChangeThinkingLevel}
          />
          {notice ? <p className="m-0 min-w-0 text-2xs break-words text-warn singleColumn:text-1xs">{notice}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function ModelEffortFields({
  settings,
  singleColumn,
  onChangeModel,
  onChangeThinkingLevel,
}: {
  settings: ComposerSettings;
  singleColumn: boolean;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
}) {
  const choices = useMemo(() => {
    const list = modelChoices(settings.modelOptions);
    // 実効値が候補に無い（利用不可）ときも現在値を表示できるようにする
    if (settings.model && !list.some((choice) => choice.value === settings.model)) {
      list.push(unavailableModelChoice(settings.model));
    }
    return list;
  }, [settings.modelOptions, settings.model]);
  // SDK が補正した実効値が候補に無くても表示できるようにする (順番は段階順のまま)
  const effortLevels = useMemo(
    () => effortChoices(settings.thinkingLevels, settings.thinkingLevel),
    [settings.thinkingLevels, settings.thinkingLevel],
  );

  const modelDisabled = settings.disabled || settings.modelOptions.length === 0;
  const effortDisabled = settings.disabled || !settings.supportsThinking || effortLevels.length === 0;

  const handleModelChange = (next: string) => {
    const choice = choices.find((candidate) => candidate.value === next);
    if (!choice?.model) return;
    onChangeModel(choice.model);
  };

  return (
    <>
      <label className={fieldLabelClass}>
        <span className={fieldNameClass}>Model</span>
        <SelectField
          aria-label="モデルを選択"
          density="sm"
          singleColumn={singleColumn}
          wrapperClassName="min-w-0 flex-1"
          value={settings.model ?? ""}
          disabled={modelDisabled}
          onChange={(event) => handleModelChange(event.currentTarget.value)}
        >
          {settings.model ? null : <option value="">未選択</option>}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </SelectField>
      </label>
      <label className={fieldLabelClass}>
        <span className={fieldNameClass}>Effort</span>
        <SelectField
          aria-label="Effort を選択"
          density="sm"
          singleColumn={singleColumn}
          wrapperClassName="min-w-0 flex-1"
          value={settings.thinkingLevel ?? ""}
          disabled={effortDisabled}
          onChange={(event) => onChangeThinkingLevel(event.currentTarget.value as ThinkingLevel)}
        >
          {settings.thinkingLevel ? null : <option value="">未選択</option>}
          {effortLevels.map((level) => (
            <option key={level} value={level}>
              {effortLabel(level)}
            </option>
          ))}
        </SelectField>
      </label>
    </>
  );
}
