// 24 時間の推移の対象選びと downsample を固定する。
import { describe, expect, test } from "bun:test";
import type { UsageWindow } from "../src/server/providers/types";
import { buildTrend, selectTrendWindow, TREND_BUCKET_MS, TREND_MAX_POINTS } from "../src/server/trend";

const BASE = 1_800_000_000_000;

function window(id: string, usedPercent: number, durationSeconds: number | null = null): UsageWindow {
  return { id, label: id, durationSeconds, usedPercent, resetsAt: null };
}

describe("selectTrendWindow", () => {
  test("最も使用率が高い窓を選ぶ", () => {
    expect(selectTrendWindow([window("a", 10), window("b", 80), window("c", 40)])?.id).toBe("b");
  });

  test("同値なら期間が短い窓を選ぶ", () => {
    expect(selectTrendWindow([window("weekly", 50, 604_800), window("rolling", 50, 18_000)])?.id).toBe("rolling");
  });

  test("窓が無ければ null", () => {
    expect(selectTrendWindow([])).toBeNull();
  });
});

describe("buildTrend", () => {
  test("30 分の bucket へ平均し、古い順に返す", () => {
    const trend = buildTrend("rolling", [
      { at: BASE, usedPercent: 10 },
      { at: BASE + 5 * 60 * 1000, usedPercent: 20 },
      { at: BASE + TREND_BUCKET_MS, usedPercent: 40 },
    ]);

    expect(trend).toEqual({
      windowId: "rolling",
      points: [
        { at: BASE, usedPercent: 15 },
        { at: BASE + TREND_BUCKET_MS, usedPercent: 40 },
      ],
    });
  });

  test("2 点未満なら推移を返さない", () => {
    expect(buildTrend("rolling", [])).toBeNull();
    expect(buildTrend("rolling", [{ at: BASE, usedPercent: 10 }])).toBeNull();
  });

  test("bucket が 48 を超えたら新しい側の 48 点に絞る", () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({
      at: BASE + index * TREND_BUCKET_MS,
      usedPercent: index,
    }));
    const trend = buildTrend("rolling", samples);

    expect(trend?.points).toHaveLength(TREND_MAX_POINTS);
    expect(trend?.points.at(-1)?.usedPercent).toBe(59);
  });

  test("数値でない点は捨てる", () => {
    const trend = buildTrend("rolling", [
      { at: BASE, usedPercent: 10 },
      { at: Number.NaN, usedPercent: 20 },
      { at: BASE + TREND_BUCKET_MS, usedPercent: 30 },
    ]);

    expect(trend?.points).toHaveLength(2);
  });
});
