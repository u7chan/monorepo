import type { ImageParameterDraft, ImageParameterField, ImageParameterName } from "../../lib/imageParameters";
import { SelectField } from "../SelectField";

/**
 * 画像の生成パラメータの入力欄。設定の既定の編集と試行の入力が同じ規則（欄の種類・並び・空欄の扱い）を使う。
 * 面ごとに違う aria-label の接頭辞・空欄の文言・欄ごとの操作だけを引数に取り、欄ごとの操作が無い面では
 * 包まずに欄だけを並べる（操作を持たない面の DOM を増やさない）。
 */
export function ImageParameterFields({
  fields,
  values,
  onChange,
  disabled,
  labelPrefix,
  emptyLabel,
  fieldAction,
}: {
  fields: readonly ImageParameterField[];
  values: ImageParameterDraft;
  /** 欄の値をそのまま渡す（空文字は未指定）。どの下書きへ書くかは呼び出し側が決める */
  onChange: (name: ImageParameterName, value: string) => void;
  disabled: boolean;
  /** aria-label の接頭辞（「既定の」「試行の」） */
  labelPrefix: string;
  /** 空欄の選択肢と placeholder に出す文言 */
  emptyLabel: string;
  /** 欄ごとに出す操作（試行の「既定に戻す」）。空欄の欄には出さない */
  fieldAction?: { label: string; onClick: (name: ImageParameterName) => void };
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {fields.map((field) => {
        const value = values[field.name] ?? "";
        const ariaLabel = `${labelPrefix} ${field.name}`;
        const label = (
          <label key={field.name} className="grid min-w-0 gap-1">
            <span className="text-2xs text-ink-muted">{field.name}</span>
            {field.kind === "enum" ? (
              <SelectField
                aria-label={ariaLabel}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(field.name, event.currentTarget.value)}
              >
                <option value="">{emptyLabel}</option>
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
                placeholder={emptyLabel}
                aria-label={ariaLabel}
                disabled={disabled}
                onChange={(event) => onChange(field.name, event.currentTarget.value)}
              />
            )}
          </label>
        );
        if (fieldAction === undefined) return label;
        return (
          <div key={field.name} className="grid content-start gap-1">
            {label}
            {value === "" ? null : (
              <button
                type="button"
                className="btn-quiet w-fit"
                disabled={disabled}
                onClick={() => fieldAction.onClick(field.name)}
              >
                {fieldAction.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
