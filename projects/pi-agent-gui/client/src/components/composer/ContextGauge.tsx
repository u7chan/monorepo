import { contextGauge } from "../../lib/usageFormat";
import type { ContextUsage } from "../../types";

/** activity が空でもゲージだけは常時出す (コンテキスト量はいつでも見たい) */
export function ContextGauge({
  activity,
  context,
  compact,
}: {
  activity: string;
  context?: ContextUsage;
  compact: boolean;
}) {
  const gauge = contextGauge(context, compact);
  if (!activity && !gauge) return null;
  const gaugeColor =
    gauge?.level === "danger" ? "text-danger-text" : gauge?.level === "warn" ? "text-warn" : "text-ink-faint";

  return (
    <div className="flex min-h-[21px] items-center gap-2 px-1 pb-1.5 text-[11px] text-ink-muted">
      <span aria-live="polite" className="min-w-0 flex-1 break-words">
        {activity}
      </span>
      {gauge ? (
        <span className={["shrink-0 whitespace-nowrap font-sans text-[10px] tabular-nums", gaugeColor].join(" ")}>
          Context
          {/* バーは CSS 描画。ブロック要素のグリフは端末のフォント次第で崩れるうえ、
              等幅にならないので tabular-nums も効かない */}
          <span
            role="progressbar"
            aria-label="コンテキスト使用量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={gauge.fill === null ? undefined : Math.round(gauge.fill * 100)}
            className="mx-1 inline-block h-[5px] w-10 overflow-hidden rounded-full bg-line-strong align-middle"
          >
            {gauge.fill === null || gauge.fill <= 0 ? null : (
              // 極小の百分率でも「空」と見分けが付くように最小幅を持たせる
              <span
                className="block h-full rounded-full bg-current"
                style={{ width: `${gauge.fill * 100}%`, minWidth: 2 }}
              />
            )}
          </span>{" "}
          {gauge.percent} {gauge.detail ? <span className="text-ink-ghost">{gauge.detail}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
