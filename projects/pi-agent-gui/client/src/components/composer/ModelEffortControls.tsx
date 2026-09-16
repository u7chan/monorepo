import { useMemo } from "react";
import { effortLabel, type ComposerSettings } from "../../hooks/useAgentDesk";
import { cn } from "../../lib/cn";
import type { ModelRef, ThinkingLevel } from "../../types";
import { SelectField } from "../SelectField";
import { SlidersIcon } from "../icons";
import { fieldLabelClass, fieldNameClass } from "./fieldStyles";

/** 候補に無いモデルも表示できるよう選択肢へ足す */
function modelChoicesOf(settings: ComposerSettings): Array<{ value: string; label: string }> {
  const choices = settings.modelOptions.map((option) => ({
    value: `${option.provider}/${option.id}`,
    label: option.name ? `${option.name}（${option.provider}/${option.id}）` : `${option.provider}/${option.id}`,
  }));
  if (settings.model && !choices.some((choice) => choice.value === settings.model)) {
    choices.push({ value: settings.model, label: `${settings.model}（利用不可）` });
  }
  return choices;
}

export function ModelEffortToggle({
  open,
  compact,
  onToggle,
}: {
  open: boolean;
  compact: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="モデルと Effort の設定"
      title="モデルと Effort"
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full border transition-colors",
        compact ? "size-9" : "size-7",
        open
          ? "border-accent/50 bg-accent-wash text-accent-text"
          : "border-line bg-raised text-ink-faint hover:text-ink-soft",
      )}
    >
      <SlidersIcon />
    </button>
  );
}

export function ModelEffortFields({
  settings,
  compact,
  onChangeModel,
  onChangeThinkingLevel,
}: {
  settings: ComposerSettings;
  compact: boolean;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
}) {
  const modelChoices = useMemo(() => modelChoicesOf(settings), [settings]);
  // SDK が補正した実効値が候補に無くても表示できるようにする
  const effortChoices = useMemo(() => {
    const levels = [...settings.thinkingLevels];
    const current = settings.thinkingLevel;
    if (current && !levels.includes(current as ThinkingLevel)) levels.push(current as ThinkingLevel);
    return levels;
  }, [settings.thinkingLevels, settings.thinkingLevel]);

  const modelDisabled = settings.disabled || settings.modelOptions.length === 0;
  const effortDisabled = settings.disabled || !settings.supportsThinking || effortChoices.length === 0;

  const handleModelChange = (next: string) => {
    const slash = next.indexOf("/");
    if (slash <= 0) return;
    onChangeModel({ provider: next.slice(0, slash), id: next.slice(slash + 1) });
  };

  return (
    <>
      <label className={fieldLabelClass(compact)}>
        <span className={fieldNameClass(compact)}>Model</span>
        <SelectField
          aria-label="モデルを選択"
          density="sm"
          compact={compact}
          wrapperClassName={cn(compact ? "min-w-0 flex-1" : "max-w-60 min-w-0")}
          value={settings.model ?? ""}
          disabled={modelDisabled}
          onChange={(event) => handleModelChange(event.currentTarget.value)}
        >
          {settings.model ? null : <option value="">未選択</option>}
          {modelChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </SelectField>
      </label>
      <label className={fieldLabelClass(compact)}>
        <span className={fieldNameClass(compact)}>Effort</span>
        <SelectField
          aria-label="Effort を選択"
          density="sm"
          compact={compact}
          wrapperClassName={cn(compact ? "min-w-0 flex-1" : "max-w-40 min-w-0")}
          value={settings.thinkingLevel ?? ""}
          disabled={effortDisabled}
          onChange={(event) => onChangeThinkingLevel(event.currentTarget.value as ThinkingLevel)}
        >
          {settings.thinkingLevel ? null : <option value="">未選択</option>}
          {effortChoices.map((level) => (
            <option key={level} value={level}>
              {effortLabel(level)}
            </option>
          ))}
        </SelectField>
      </label>
    </>
  );
}
