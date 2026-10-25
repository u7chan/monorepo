import type { UsageWindow } from "../api";
import { describeReset, formatPercent, remainingPercent } from "../lib/format";
import { ATTENTION_THRESHOLD } from "../lib/status";

export function UsageMeter(props: { window: UsageWindow; now: number }) {
  const attention = props.window.usedPercent >= ATTENTION_THRESHOLD;
  const reset = describeReset(props.window.resetsAt, props.now);

  return (
    <div class="up-meter">
      <div class="up-meter-head">
        <span class="up-meter-label">{props.window.label}</span>
        <span class={attention ? "up-meter-value up-attention" : "up-meter-value"}>
          {attention ? (
            <span class="up-meter-warning" aria-hidden="true">
              ▲{" "}
            </span>
          ) : null}
          {formatPercent(props.window.usedPercent)}
        </span>
      </div>
      <div
        class="up-meter-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.window.usedPercent)}
        aria-label={`${props.window.label} の使用率`}
      >
        {/* 幅だけを style で渡す。CSP の style-src 'unsafe-inline' はこの用途に限る。 */}
        <div
          class={attention ? "up-meter-fill up-meter-fill-attention" : "up-meter-fill"}
          style={{ width: `${Math.min(100, Math.max(0, props.window.usedPercent))}%` }}
        />
      </div>
      {/* 390px 幅でも「あと 2 時 / 間」と割れないよう、残りとリセットを別の行にする。 */}
      <p class="up-caption">
        <span class="up-nowrap">
          {attention ? "▲ " : ""}残り {formatPercent(remainingPercent(props.window.usedPercent))}
        </span>
      </p>
      <p class="up-caption">
        {reset ? (
          <>
            <span class="up-nowrap">{reset.at}</span> <span class="up-nowrap">· {reset.remaining}</span>
          </>
        ) : (
          "リセット時刻は不明"
        )}
      </p>
    </div>
  );
}
