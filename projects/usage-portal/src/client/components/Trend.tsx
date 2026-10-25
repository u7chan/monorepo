import type { Trend } from "../api";

const WIDTH = 100;
const HEIGHT = 28;

/**
 * 24 時間の推移。y は 0〜100% 固定なので、値が小さくても線は下に貼り付く。
 * 数値は上の meter が持つため、chart 自体は読み上げ対象から外す。
 */
export function TrendChart(props: { trend: Trend; label: string }) {
  const points = props.trend.points;
  const first = points[0];
  const last = points.at(-1);

  if (!first || !last) {
    return null;
  }

  const span = Math.max(1, last.at - first.at);
  const coordinates = points.map((point) => {
    const x = ((point.at - first.at) / span) * WIDTH;
    const y = HEIGHT - (Math.min(100, Math.max(0, point.usedPercent)) / 100) * HEIGHT;

    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${coordinates.join(" L")}`;
  const area = `${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;

  return (
    <div class="up-trend">
      <p class="up-caption">24時間の推移（{props.label}）</p>
      <svg
        class="up-trend-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path class="up-trend-area" d={area} />
        <path class="up-trend-line" d={line} />
      </svg>
    </div>
  );
}
