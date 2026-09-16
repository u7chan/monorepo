import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";
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
    <div className="flex min-h-5.25 items-center gap-2 px-1 pb-1.5 text-1xs text-ink-muted">
      <span aria-live="polite" className="min-w-0 flex-1 break-words">
        {activity}
      </span>
      {gauge ? (
        <span className={cn("shrink-0 font-sans text-2xs whitespace-nowrap tabular-nums", gaugeColor)}>
          Context
          {/* バーは CSS 描画。ブロック要素のグリフは端末のフォント次第で崩れるうえ、
              等幅にならないので tabular-nums も効かない */}
          <span
            role="progressbar"
            aria-label="コンテキスト使用量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={gauge.fill === null ? undefined : Math.round(gauge.fill * 100)}
            className="mx-1 inline-block h-1.25 w-10 overflow-hidden rounded-full bg-line-strong align-middle"
          >
            {gauge.fill === null || gauge.fill <= 0 ? null : (
              // 極小の百分率でも「空」と見分けが付くように最小幅を持たせる
              <span
                className="block h-full w-(--gauge-fill) min-w-0.5 rounded-full bg-current"
                style={{ "--gauge-fill": `${gauge.fill * 100}%` } as CSSProperties}
              />
            )}
          </span>{" "}
          {gauge.percent} {gauge.detail ? <span className="text-ink-ghost">{gauge.detail}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
