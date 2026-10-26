import type { Trend, UsageWindow } from "../api";
import { buildTimeTicks, buildValueAxis } from "../lib/chart";
import { describeCoverage, formatSpan, remainingPercent } from "../lib/format";

/** 線が枠に貼り付かないよう、上下に少し余白を残す（viewBox の %）。 */
const PLOT_PADDING = 4;

export function TrendChart(props: {
  windows: readonly UsageWindow[];
  activeWindowId: string;
  trend: Trend | null;
  generatedAt: number | null;
  onSelect: (windowId: string) => void;
}) {
  const title = props.trend ? `残りの推移（${formatSpan(props.trend.spanMs)}）` : "残りの推移";

  return (
    <div class="up-trend">
      <div class="up-trend-head">
        <p class="up-caption">{title}</p>
        {props.windows.length > 1 ? (
          <div class="up-trend-tabs" role="group" aria-label="推移を表示する枠">
            {props.windows.map((window) => (
              <button
                key={window.id}
                class="up-trend-tab"
                type="button"
                aria-pressed={window.id === props.activeWindowId ? "true" : "false"}
                onClick={() => props.onSelect(window.id)}
              >
                {window.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {props.trend ? <Chart trend={props.trend} generatedAt={props.generatedAt} /> : <ChartEmpty />}
    </div>
  );
}

function ChartEmpty() {
  return <p class="up-caption">履歴を収集中です（5 分ごとに記録）。</p>;
}

function Chart(props: { trend: Trend; generatedAt: number | null }) {
  const points = props.trend.points;
  const remaining = points.map((point) => ({ at: point.at, value: remainingPercent(point.usedPercent) }));
  const axis = buildValueAxis(remaining.map((point) => point.value));
  const first = remaining[0];
  const last = remaining.at(-1);

  if (!axis || !first || !last) {
    return <ChartEmpty />;
  }

  const endAt = Math.max(props.generatedAt ?? last.at, last.at);
  const startAt = endAt - props.trend.spanMs;
  const xOf = (at: number) => clamp(((at - startAt) / props.trend.spanMs) * 100);
  const yOf = (value: number) => PLOT_PADDING + ((axis.max - value) / (axis.max - axis.min)) * (100 - PLOT_PADDING * 2);
  const coordinates = remaining.map((point) => [xOf(point.at), yOf(point.value)] as const);
  const firstX = xOf(first.at);
  const lastX = xOf(last.at);
  const line = `M${coordinates.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" L")}`;
  const area = `${line} L${lastX.toFixed(2)},100 L${firstX.toFixed(2)},100 Z`;
  const timeTicks = buildTimeTicks(startAt, endAt);
  const resets = props.trend.resets;
  const notes: string[] = [];

  if (resets.length > 0) {
    notes.push("点線はリセット");
  }

  if (endAt - first.at < props.trend.spanMs * 0.8) {
    notes.push(`履歴はまだ ${describeCoverage(endAt - first.at)}です`);
  }

  return (
    <>
      {/* 座標だけを style で渡す。CSP の style-src 'unsafe-inline' は meter と trend の描画に限る。 */}
      <div class="up-trend-chart">
        <div class="up-trend-y" aria-hidden="true">
          {axis.ticks.map((tick) => (
            <span key={tick} style={{ top: `${yOf(tick)}%` }}>
              {tick}%
            </span>
          ))}
        </div>
        <div class="up-trend-body">
          <div class="up-trend-plot">
            {axis.ticks.map((tick) => (
              <div key={tick} class="up-trend-grid" style={{ top: `${yOf(tick)}%` }} />
            ))}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <path class="up-trend-area" d={area} />
              <path class="up-trend-line" d={line} />
            </svg>
            {resets.map((at) => (
              <div key={at} class="up-trend-reset" style={{ left: `${xOf(at)}%` }} />
            ))}
            <div class="up-trend-dot" style={{ left: `${lastX}%`, top: `${yOf(last.value)}%` }} />
          </div>
          <div class="up-trend-x" aria-hidden="true">
            {timeTicks.map((tick) => (
              <span key={tick.at} class={xClass(tick.at, xOf)} style={{ left: `${xOf(tick.at)}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {notes.length > 0 ? <p class="up-caption">{notes.join(" · ")}</p> : null}
    </>
  );
}

function xClass(at: number, xOf: (at: number) => number): string {
  const left = xOf(at);
  const classes = ["up-trend-x-label"];

  if (left < 6) {
    classes.push("up-trend-x-first");
  } else if (left > 94) {
    classes.push("up-trend-x-last");
  }

  return classes.join(" ");
}

function clamp(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}
