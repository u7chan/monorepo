import type { UsageWindow } from "../api";
import { describeReset, formatPercent, remainingPercent } from "../lib/format";
import { ATTENTION_THRESHOLD } from "../lib/status";

export function UsageMeter(props: { window: UsageWindow; now: number }) {
  const remaining = remainingPercent(props.window.usedPercent);
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
          残り {formatPercent(remaining)}
        </span>
      </div>
      <div
        class="up-meter-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        aria-valuetext={`残り ${formatPercent(remaining)}`}
        aria-label={`${props.window.label} の残り`}
      >
        {/* 幅だけを style で渡す。CSP の style-src 'unsafe-inline' は meter と trend の座標に限る。 */}
        <div
          class={attention ? "up-meter-fill up-meter-fill-attention" : "up-meter-fill"}
          style={{ width: `${remaining}%` }}
        />
      </div>
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
