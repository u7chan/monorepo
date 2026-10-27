// 推移の横軸の期間、間引き（bucket ごとの代表点）、リセット検出、点数上限を固定する。
import { describe, expect, test } from "bun:test";
import type { UsageWindow } from "../src/server/providers/types";
import { buildTrend, MAX_TREND_SPAN_MS, TREND_MAX_POINTS, trendSpanMs } from "../src/server/trend";

const BASE = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function window(id: string, label: string, durationSeconds: number | null = null): UsageWindow {
  return { id, label, durationSeconds, usedPercent: 10, resetsAt: null };
}

describe("trendSpanMs", () => {
  test("durationSeconds があればその期間を横軸にする", () => {
    expect(trendSpanMs(window("primary", "週次", 18_000))).toBe(5 * HOUR);
  });

  test("OpenCode Go は id から期間を決める", () => {
    expect(trendSpanMs(window("rolling", "ローリング"))).toBe(6 * HOUR);
    expect(trendSpanMs(window("weekly", "週次"))).toBe(7 * DAY);
    expect(trendSpanMs(window("monthly", "月次"))).toBe(30 * DAY);
  });

  test("id が未知なら、ラベルが週次でも 24 時間にする", () => {
    expect(trendSpanMs(window("primary", "ローリング"))).toBe(24 * HOUR);
    expect(trendSpanMs(window("primary", "週次"))).toBe(24 * HOUR);
    expect(trendSpanMs(window("secondary", "月次"))).toBe(24 * HOUR);
  });

  test("どちらも読めなければ 24 時間、保持期間の 30 日で頭打ち", () => {
    expect(trendSpanMs(window("unknown", "不明"))).toBe(24 * HOUR);
    expect(trendSpanMs(window("yearly", "月次", 365 * 24 * 3600))).toBe(MAX_TREND_SPAN_MS);
  });
});

describe("buildTrend", () => {
  test("bucket 内は新しい sample を代表点にする", () => {
    const trend = buildTrend("primary", 24 * HOUR, [
      { at: BASE, usedPercent: 10 },
      { at: BASE + 5 * MINUTE, usedPercent: 20 },
      { at: BASE + 30 * MINUTE, usedPercent: 40 },
      { at: BASE + 24 * HOUR, usedPercent: 50 },
    ]);

    expect(trend).toEqual({
      windowId: "primary",
      spanMs: 24 * HOUR,
      points: [
        { at: BASE + 5 * MINUTE, usedPercent: 20 },
        { at: BASE + 30 * MINUTE, usedPercent: 40 },
        { at: BASE + 24 * HOUR, usedPercent: 50 },
      ],
      resets: [],
    });
  });

  test("同じ bucket 内で使用率が戻ってもリセットを resets に残す", () => {
    const trend = buildTrend("primary", 24 * HOUR, [
      { at: BASE - 25 * MINUTE, usedPercent: 20 },
      { at: BASE - 10 * MINUTE, usedPercent: 0 },
      { at: BASE - 5 * MINUTE, usedPercent: 20 },
      { at: BASE + 24 * HOUR, usedPercent: 20 },
    ]);

    // 代表点は 20% のままなので、点列だけではリセットを検出できない。
    expect(trend?.points.map((point) => point.usedPercent)).toEqual([20, 20]);
    expect(trend?.resets).toEqual([BASE - 10 * MINUTE]);
  });

  test("使用率が下がらなければ resets は空", () => {
    const trend = buildTrend("rolling", 6 * HOUR, [
      { at: BASE, usedPercent: 10 },
      { at: BASE + 30 * MINUTE, usedPercent: 20 },
    ]);

    expect(trend?.resets).toEqual([]);
  });

  test("履歴が短いうちは 5 分単位まで細かく刻む", () => {
    const trend = buildTrend("weekly", 7 * DAY, [
      { at: BASE, usedPercent: 10 },
      { at: BASE + 2 * MINUTE, usedPercent: 20 },
      { at: BASE + 30 * MINUTE, usedPercent: 30 },
    ]);

    expect(trend?.points).toEqual([
      { at: BASE + 2 * MINUTE, usedPercent: 20 },
      { at: BASE + 30 * MINUTE, usedPercent: 30 },
    ]);
  });

  test("2 点未満なら推移を返さない", () => {
    expect(buildTrend("rolling", 6 * HOUR, [])).toBeNull();
    expect(buildTrend("rolling", 6 * HOUR, [{ at: BASE, usedPercent: 10 }])).toBeNull();
  });

  test("数値でない点は捨てる", () => {
    const trend = buildTrend("rolling", 6 * HOUR, [
      { at: BASE, usedPercent: 10 },
      { at: Number.NaN, usedPercent: 20 },
      { at: BASE + 30 * MINUTE, usedPercent: 30 },
    ]);

    expect(trend?.points).toHaveLength(2);
  });

  test("48 点を超えたら新しい側の 48 点に絞る", () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({
      at: BASE + index * 30 * MINUTE,
      usedPercent: index,
    }));
    const trend = buildTrend("rolling", 24 * HOUR, samples);

    expect(trend?.points).toHaveLength(TREND_MAX_POINTS);
    expect(trend?.points.at(-1)?.usedPercent).toBe(59);
  });
});
