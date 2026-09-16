import { useMemo } from "react";
import { ALL_THINKING_LEVELS, effortLabel } from "../../hooks/useAgentDesk";
import type { ModelOption, ModelRef, ThinkingLevel } from "../../types";
import { SelectField } from "../SelectField";

const modelValueOf = (ref: ModelRef | null): string => (ref ? `${ref.provider}/${ref.id}` : "");

export function AgentModelEffortFields({
  model,
  thinkingLevel,
  modelOptions,
  defaultModel,
  defaultThinkingLevel,
  onChangeModel,
  onChangeThinkingLevel,
}: {
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  modelOptions: ModelOption[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  onChangeModel: (model: ModelRef | null) => void;
  onChangeThinkingLevel: (level: ThinkingLevel | null) => void;
}) {
  const modelValue = modelValueOf(model);
  // Model 未指定のときはアプリ既定モデルの対応段階を使い、既定も解決できないときだけ全段階を出す。
  const effortModel = modelValue || defaultModel;
  const effortOption = effortModel
    ? modelOptions.find((option) => `${option.provider}/${option.id}` === effortModel)
    : undefined;
  const thinkingLevels = effortOption?.thinkingLevels ?? ALL_THINKING_LEVELS;
  const supportsThinking = effortOption?.supportsThinking ?? true;
  const modelMissing =
    Boolean(modelValue) && !modelOptions.some((option) => `${option.provider}/${option.id}` === modelValue);

  const modelChoices = useMemo(() => {
    const choices = modelOptions.map((option) => ({
      value: `${option.provider}/${option.id}`,
      label: `${option.name}（${option.provider}/${option.id}）`,
    }));
    if (modelValue && !choices.some((choice) => choice.value === modelValue)) {
      choices.push({ value: modelValue, label: `${modelValue}（利用不可）` });
    }
    return choices;
  }, [modelOptions, modelValue]);

  const effortChoices = useMemo(() => {
    const levels = [...thinkingLevels];
    if (thinkingLevel && !levels.includes(thinkingLevel)) levels.push(thinkingLevel);
    return levels;
  }, [thinkingLevels, thinkingLevel]);

  const changeModel = (value: string) => {
    if (!value) {
      onChangeModel(null);
      return;
    }
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    onChangeModel({ provider: value.slice(0, slash), id: value.slice(slash + 1) });
  };

  return (
    <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2.5">
      <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">Model / Effort</div>
      <div className="grid gap-2 wide:grid-cols-2">
        <label className="grid gap-1 text-1xs text-ink-soft">
          Model
          <SelectField
            wrapperClassName="w-full"
            aria-label="エージェントのモデル"
            value={modelValue}
            onChange={(e) => changeModel(e.currentTarget.value)}
          >
            <option value="">未指定（アプリ既定）</option>
            {modelChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </SelectField>
        </label>
        <label className="grid gap-1 text-1xs text-ink-soft">
          Effort
          <SelectField
            wrapperClassName="w-full"
            aria-label="エージェントの Effort"
            value={thinkingLevel ?? ""}
            onChange={(e) => {
              onChangeThinkingLevel((e.currentTarget.value || null) as ThinkingLevel | null);
            }}
          >
            <option value="">
              {defaultThinkingLevel ? `未指定（アプリ既定: ${effortLabel(defaultThinkingLevel)}）` : "未指定"}
            </option>
            {effortChoices.map((level) => (
              <option key={level} value={level} disabled={!supportsThinking}>
                {effortLabel(level)}
              </option>
            ))}
          </SelectField>
        </label>
      </div>
      <p className="text-2xs leading-relaxed text-ink-ghost">
        {modelMissing
          ? "保存済みモデルは現在利用できません。別の候補を選ぶか未指定にすると回復できます。"
          : !effortOption
            ? "利用可能なモデルを特定できないため、Effort は全段階を表示しています。使用モデルに応じて補正されます。"
            : !supportsThinking
              ? "使用モデルは推論に対応していないため Effort を選べません。未指定に戻す操作は可能です。"
              : "ここで指定した値は新しい会話の初期値になります。既存の会話には反映されません。"}
      </p>
    </div>
  );
}
