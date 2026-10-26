// グラフの縦軸の自動レンジ、横軸の目盛り位置、リセット判定を固定する。
import { describe, expect, test } from "bun:test";
import { buildTimeTicks, buildValueAxis, findResets } from "../src/client/lib/chart";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("buildValueAxis", () => {
  test("変化が小さくても最小 10pt の幅を確保する", () => {
    expect(buildValueAxis([78, 84])).toEqual({ min: 75, max: 90, ticks: [75, 80, 85, 90] });
    expect(buildValueAxis([100, 100])).toEqual({ min: 90, max: 100, ticks: [90, 95, 100] });
  });

  test("広い範囲でも 0〜100 を超えない", () => {
    expect(buildValueAxis([42, 100])).toEqual({ min: 20, max: 100, ticks: [20, 40, 60, 80, 100] });
  });

  test("値が無ければ null", () => {
    expect(buildValueAxis([])).toBeNull();
    expect(buildValueAxis([Number.NaN])).toBeNull();
  });
});

describe("buildTimeTicks", () => {
  test("7 日は日付の目盛りを置き、右端は今", () => {
    const end = new Date(2026, 10, 18, 12, 0).getTime();
    const ticks = buildTimeTicks(end - 7 * DAY, end);

    expect(ticks.map((tick) => tick.label)).toEqual(["11/12", "11/14", "11/16", "今"]);
    expect(ticks.at(-1)?.at).toBe(end);
  });

  test("30 日は 7 日おきの日付にする", () => {
    const end = new Date(2026, 10, 18, 12, 0).getTime();
    const ticks = buildTimeTicks(end - 30 * DAY, end);

    expect(ticks.map((tick) => tick.label)).toEqual(["10/20", "10/27", "11/03", "11/10", "今"]);
  });

  test("1 日未満は時刻の目盛りにする", () => {
    const end = new Date(2026, 10, 18, 8, 0).getTime();

    expect(buildTimeTicks(end - 6 * HOUR, end).map((tick) => tick.label)).toEqual(["03:00", "05:00", "07:00", "今"]);
    expect(buildTimeTicks(end - 5 * HOUR, end).map((tick) => tick.label)).toEqual(["04:00", "06:00", "今"]);
  });

  test("範囲が無効なら空", () => {
    expect(buildTimeTicks(Number.NaN, 0)).toEqual([]);
    expect(buildTimeTicks(100, 100)).toEqual([]);
  });
});

describe("findResets", () => {
  test("使用率が 5 ポイント以上下がった点をリセットとして返す", () => {
    expect(
      findResets([
        { at: 1, usedPercent: 10 },
        { at: 2, usedPercent: 12 },
        { at: 3, usedPercent: 0 },
      ]),
    ).toEqual([3]);
    expect(
      findResets([
        { at: 1, usedPercent: 10 },
        { at: 2, usedPercent: 6 },
      ]),
    ).toEqual([]);
  });
});
