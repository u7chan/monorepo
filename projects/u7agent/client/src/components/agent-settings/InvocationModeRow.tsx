import { ToggleSwitch } from "../ToggleSwitch";

/** スイッチのラベル。ON = 現行どおり自然文でも発火する */
export const NATURAL_INVOCATION_LABEL = "自然文でも発火";
/** OFF のときに出すチップ。スキルボタン / `/skill:` からだけ使える状態を短く示す */
export const MANUAL_ONLY_LABEL = "手動のみ";
/** 組み込みスキル側の行見出し。読み上げ名にも同じ語を入れて 2 つのスイッチを区別する */
export const NATURAL_INVOCATION_BUILTIN_SCOPE_LABEL = "組み込みスキル";
/**
 * ファイルスキル側の行見出し。API の `allowNaturalInvocationFile` は共通 `.agents/skills` と
 * プロジェクト `<cwd>/.agents/skills` の両方を指すので、画面では対象を括弧で明示する。
 */
export const NATURAL_INVOCATION_FILE_SCOPE_LABEL = "ユーザー作成スキル（共通・プロジェクト）";
/** ON の説明。行ごとの「使用」ではなく、そのスコープのスキル全体に掛かることを示す */
export const NATURAL_INVOCATION_ON_NOTE = "このスコープのスキルを自然文でも発火します。";
/** OFF の説明。手動でも使えることを、行のチェックを外すのと混同させない */
export const NATURAL_INVOCATION_OFF_NOTE = "スキルボタンからは使えます。";

/**
 * スコープ 1 つ分の起動モード。ON なら自然文でも発火し、OFF なら `/skill:` とスキルボタンだけになる。
 * 行ごとの「使用」とは別の軸なので、チェックの列ではなくカード上部に並べ、行の見出しでスコープを示す。
 */
export function InvocationModeRow({
  scopeLabel,
  allowNaturalInvocation,
  onChange,
  readOnly = false,
}: {
  /** 行の見出し。読み上げ名にも入れて、2 つのスイッチを区別できるようにする */
  scopeLabel: string;
  allowNaturalInvocation: boolean;
  /** readOnly のときは呼ばれない */
  onChange?: (allowed: boolean) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-raised px-2.5 py-2">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 text-2xs font-semibold text-ink">{scopeLabel}</span>
        {allowNaturalInvocation ? null : (
          <span className="shrink-0 rounded border border-line bg-soft px-1.5 text-2xs leading-4 text-ink-ghost">
            {MANUAL_ONLY_LABEL}
          </span>
        )}
        <span className="min-w-0 text-2xs leading-4 text-ink-muted">
          {allowNaturalInvocation ? NATURAL_INVOCATION_ON_NOTE : NATURAL_INVOCATION_OFF_NOTE}
        </span>
      </span>
      <ToggleSwitch
        checked={allowNaturalInvocation}
        label={`${NATURAL_INVOCATION_LABEL}（${scopeLabel}）`}
        disabled={readOnly}
        onChange={onChange ?? (() => undefined)}
      />
    </div>
  );
}
