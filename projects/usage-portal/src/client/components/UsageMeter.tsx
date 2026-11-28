import type { UsageWindow } from "../api";
import { describeReset, formatPercent, remainingPercent } from "../lib/format";
import { ATTENTION_THRESHOLD } from "../lib/status";
import { isRolling } from "../lib/windows";
import { ProhibitedIcon, WarningIcon } from "./Icons";

export function UsageMeter(props: { window: UsageWindow; now: number; blockedBy: string | null }) {
  const remaining = remainingPercent(props.window.usedPercent);
  const reached = props.window.usedPercent >= 100;
  const stopped = props.blockedBy !== null || reached;
  const attention = !stopped && props.window.usedPercent >= ATTENTION_THRESHOLD;
  // 停止と注意は色だけが違うため、修飾子を 1 つに畳んで 3 箇所で使い回す。
  const tone = stopped ? "blocked" : attention ? "attention" : null;
  const reset = describeReset(props.window.resetsAt, props.now, { rolling: isRolling(props.window) });
  const value = (
    <>
      {stopped ? <ProhibitedIcon /> : attention ? <WarningIcon /> : null}
      <span>{stopped ? "使用不可" : `残り ${formatPercent(remaining)}`}</span>
    </>
  );

  return (
    <div class="up-meter">
      <div class="up-meter-head">
        <span class="up-meter-label">{props.window.label}</span>
        <span class={tone ? `up-meter-value up-${tone}` : "up-meter-value"}>{value}</span>
      </div>
      <div
        class="up-meter-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        aria-valuetext={
          props.blockedBy ? `${props.blockedBy}が上限のため使用できません` : `残り ${formatPercent(remaining)}`
        }
        aria-label={`${props.window.label} の残り`}
      >
        {/* 幅だけを style で渡す。CSP の style-src 'unsafe-inline' は meter と trend の座標に限る。 */}
        <div
          class={tone ? `up-meter-fill up-meter-fill-${tone}` : "up-meter-fill"}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <p class="up-caption up-meter-reset">
        {props.blockedBy ? (
          `${props.blockedBy}が上限のため使えません`
        ) : reset ? (
          <>
            <span class="up-badge">{reset.remaining}</span>
            <span class="up-nowrap">{reset.at}</span>
          </>
        ) : (
          "リセット時刻は不明"
        )}
      </p>
    </div>
  );
}

/** 値の無い枠。バーは破線の枠だけにして、0% ではなく「枠が無い」と読ませる。 */
export function AbsentMeter(props: { label: string; note: string }) {
  // progressbar にすると 0% か 100% のどちらかに読める。値が無いことは文で伝える。
  return (
    <div class="up-meter" data-state="absent">
      <div class="up-meter-head">
        <span class="up-meter-label">{props.label}</span>
        <span class="up-meter-value">—</span>
      </div>
      <div class="up-meter-track" data-state="absent" aria-hidden="true" />
      <p class="up-caption up-meter-reset">{props.note}</p>
    </div>
  );
}
