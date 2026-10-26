import { ToggleSwitch } from "../ToggleSwitch";

/** スイッチのラベル。ON = 現行どおり自然文でも発火する */
export const NATURAL_INVOCATION_LABEL = "自然文でも発火";
/** OFF のときに出すチップ。スキルボタン / `/skill:` からだけ使える状態を短く示す */
export const MANUAL_ONLY_LABEL = "手動のみ";
/** ON の説明。行ごとの「使用」ではなく、使用中のスキル全体に掛かることを示す */
export const NATURAL_INVOCATION_ON_NOTE = "使用中のスキルが対象です。";
/** OFF の説明。手動でも使えることを、行のチェックを外すのと混同させない */
export const NATURAL_INVOCATION_OFF_NOTE = "スキルボタンからは使えます。";

/**
 * スキル全体の起動モードを 1 行で切り替える。ON なら自然文でも発火し、OFF なら `/skill:` と
 * スキルボタンだけになる。行ごとの「使用」とは別の軸なので、チェックの列ではなくカード上部に置く。
 */
export function InvocationModeRow({
  allowNaturalInvocation,
  onChange,
  readOnly = false,
}: {
  allowNaturalInvocation: boolean;
  /** readOnly のときは呼ばれない */
  onChange?: (allowed: boolean) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-raised px-2.5 py-2">
      <span className="flex min-w-0 items-center gap-2">
        {allowNaturalInvocation ? null : (
          <span className="shrink-0 rounded border border-line bg-soft px-1.5 text-2xs leading-4 text-ink-ghost">
            {MANUAL_ONLY_LABEL}
          </span>
        )}
        <span className="min-w-0 truncate text-2xs text-ink-muted">
          {allowNaturalInvocation ? NATURAL_INVOCATION_ON_NOTE : NATURAL_INVOCATION_OFF_NOTE}
        </span>
      </span>
      <ToggleSwitch
        checked={allowNaturalInvocation}
        label={NATURAL_INVOCATION_LABEL}
        disabled={readOnly}
        onChange={onChange ?? (() => undefined)}
      />
    </div>
  );
}
