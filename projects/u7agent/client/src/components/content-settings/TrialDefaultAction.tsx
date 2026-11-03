import { useEffect, useRef, useState } from "react";
import { createTrialDefaultAction, INITIAL_TRIAL_DEFAULT_STATE, type TrialDefaultState } from "../../lib/trialDefault";
import { CheckIcon } from "../icons";

/** 保存できなかったときの 1 行。理由は共有の設定の注記に出るため、ここでは取り違えを防ぐ文言だけを出す */
const FAILED_NOTE = "既定として保存できませんでした。画面の注記を確認してください。";

/**
 * 試行の結果から、その試行のモデル（音声はボイスも）を既定として保存する。[`target`] が null
 * （保存値と同じ / 本文を作れない）のときは出さない。
 */
export function TrialDefaultAction<Target>({
  label,
  target,
  disabled,
  blockedReason,
  onSave,
}: {
  label: string;
  /** 保存する対象。null なら導線を出さない */
  target: Target | null;
  disabled: boolean;
  /** 保存できない理由（設定を確認できていないなど）。指定すると押せなくし、理由を添える */
  blockedReason?: string | null;
  /** 保存と、成功したときの後始末（下書きを捨てる）。保存できたかを返す */
  onSave: (target: Target) => Promise<boolean>;
}) {
  const [state, setState] = useState<TrialDefaultState>(INITIAL_TRIAL_DEFAULT_STATE);
  // 破棄は世代だけで表すため、controller は 1 つ作って使い回す（StrictMode の effect 再実行で壊さない）
  const actionRef = useRef<ReturnType<typeof createTrialDefaultAction> | null>(null);
  if (actionRef.current === null) actionRef.current = createTrialDefaultAction({ onChange: setState });
  const action = actionRef.current;
  useEffect(() => () => action.invalidate(), [action]);

  if (target === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-quiet"
        disabled={disabled || blockedReason != null || state.saving}
        onClick={() => void action.run(target, onSave)}
      >
        <CheckIcon />
        {label}
      </button>
      {blockedReason != null ? (
        <span className="text-2xs break-words text-ink-faint">{blockedReason}</span>
      ) : state.failed ? (
        <p role="alert" className="text-2xs break-words text-warn">
          {FAILED_NOTE}
        </p>
      ) : null}
    </div>
  );
}
