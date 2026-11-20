// 開始予約の時刻の計算（空きの候補・おすすめ・枠の時刻）と、画面の入力の検証を固定する。
import { describe, expect, test } from "bun:test";
import {
  latestStartSlot,
  nextStartSlot,
  readClaudeStartSettings,
  recommendedStartOption,
  startCycle,
  startCycleOptions,
  startSlots,
  type ClaudeStartSettings,
} from "../src/shared/claude-start";

const HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

function settings(overrides: Partial<ClaudeStartSettings> = {}): ClaudeStartSettings {
  return {
    anchorMinute: 22 * HOUR,
    count: 4,
    option: 3,
    days: [0, 1, 2, 3, 4, 5, 6],
    timeZone: "Asia/Tokyo",
    model: "haiku",
    effort: "low",
    ...overrides,
  };
}

/** Asia/Tokyo の壁時計の時刻を epoch へ。 */
function tokyo(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

describe("startCycle", () => {
  test("22:00 を 3 番目の窓の終わりにすると、7 / 12 / 17 / 22 時に開始し、3:00〜7:00 が空く", () => {
    expect(startCycle(22 * HOUR, 4, 3)).toEqual({
      option: 3,
      starts: [7 * HOUR, 12 * HOUR, 17 * HOUR, 22 * HOUR],
      gapFrom: 27 * HOUR,
      gapTo: 31 * HOUR,
    });
  });

  test("空きの候補は回数と同じ数だけあり、どれも 22:00 にリセットする窓を含む", () => {
    const options = startCycleOptions(22 * HOUR, 4);

    expect(options).toHaveLength(4);

    for (const cycle of options) {
      expect(cycle.starts.some((start) => (start + 5 * HOUR) % (24 * HOUR) === 22 * HOUR)).toBe(true);
    }
  });

  test("回数が少ないほど空きが長い", () => {
    const cycle = startCycle(12 * HOUR, 1, 1);

    expect(cycle.starts).toEqual([7 * HOUR]);
    expect(cycle.gapTo - cycle.gapFrom).toBe(19 * HOUR);
  });
});

describe("recommendedStartOption", () => {
  test("22:00・4 回なら、空きが深夜（3:00〜7:00）に来る候補を選ぶ", () => {
    expect(recommendedStartOption(22 * HOUR, 4)).toBe(3);
  });

  test("空きが日をまたぐ候補も、深夜との重なりで比べる", () => {
    const option = recommendedStartOption(23 * HOUR, 4);
    const cycle = startCycle(23 * HOUR, 4, option);

    // 4:00〜8:00 の空きは深夜と 3 時間重なり、ほかの候補より長い。
    expect(cycle.gapFrom % (24 * HOUR)).toBe(4 * HOUR);
  });
});

describe("readClaudeStartSettings", () => {
  test("正しい入力は曜日を重複なしの昇順にして返す", () => {
    expect(readClaudeStartSettings({ ...settings(), days: [5, 1, 1] })?.days).toEqual([1, 5]);
  });

  test.each([
    ["時刻が 1 日を超える", { anchorMinute: 1440 }],
    ["時刻が整数でない", { anchorMinute: 1.5 }],
    ["回数が 0", { count: 0 }],
    ["回数が 5", { count: 5 }],
    ["空きの番号が回数を超える", { count: 2, option: 3 }],
    ["曜日が空", { days: [] }],
    ["曜日が範囲外", { days: [7] }],
    ["知らないタイムゾーン", { timeZone: "Mars/Olympus" }],
    ["知らないモデル", { model: "gpt" }],
    ["知らない思考レベル", { effort: "max" }],
  ])("%s なら null", (_label, patch) => {
    expect(readClaudeStartSettings({ ...settings(), ...patch })).toBeNull();
  });

  test("オブジェクトでなければ null", () => {
    expect(readClaudeStartSettings(null)).toBeNull();
    expect(readClaudeStartSettings("22:00")).toBeNull();
  });
});

describe("startSlots", () => {
  test("予約したタイムゾーンの壁時計で、その日の開始を順に返す", () => {
    const from = tokyo("2026-11-20", "00:00");
    const to = tokyo("2026-11-20", "23:59");

    expect(startSlots(settings(), from, to)).toEqual([
      tokyo("2026-11-20", "07:00"),
      tokyo("2026-11-20", "12:00"),
      tokyo("2026-11-20", "17:00"),
      tokyo("2026-11-20", "22:00"),
    ]);
  });

  test("曜日は空きのあとの最初の開始の日で数え、翌日に回る開始もその日の分に含める", () => {
    // 2026-11-20 は金曜。開始 22 / 3 / 8 / 13 時の候補では、金曜の分の 3 時と 8 時と 13 時は土曜に入る。
    const friday = settings({ option: 1, days: [5] });
    const slots = startSlots(friday, tokyo("2026-11-20", "00:00"), tokyo("2026-11-22", "00:00"));

    expect(slots).toEqual([
      tokyo("2026-11-20", "17:00"),
      tokyo("2026-11-20", "22:00"),
      tokyo("2026-11-21", "03:00"),
      tokyo("2026-11-21", "08:00"),
    ]);
  });

  test("選んでいない曜日には開始しない", () => {
    const weekdays = settings({ days: [1, 2, 3, 4, 5] });

    expect(startSlots(weekdays, tokyo("2026-11-21", "00:00"), tokyo("2026-11-22", "23:59"))).toEqual([]);
  });

  test("夏時間のあるタイムゾーンでも、切り替えの前後で同じ壁時計の時刻に開始する", () => {
    const newYork = settings({ timeZone: "America/New_York", anchorMinute: 12 * HOUR, count: 1, option: 1 });
    // 2026-03-08 に夏時間へ切り替わる。前日と翌日の 7:00 の間隔は 23 時間になる。
    const [before, after] = startSlots(
      newYork,
      Date.parse("2026-03-07T00:00:00-05:00"),
      Date.parse("2026-03-08T23:00:00-04:00"),
    );

    expect(before).toBe(Date.parse("2026-03-07T07:00:00-05:00"));
    expect(after).toBe(Date.parse("2026-03-08T07:00:00-04:00"));
  });
});

describe("nextStartSlot / latestStartSlot", () => {
  test("次の開始は、ちょうどの時刻を含めず後ろの枠を返す", () => {
    expect(nextStartSlot(settings(), tokyo("2026-11-20", "12:00"))).toBe(tokyo("2026-11-20", "17:00"));
  });

  test("最後の開始は、さかのぼる範囲の中だけを見る", () => {
    const at = tokyo("2026-11-20", "12:10");

    expect(latestStartSlot(settings(), at, HOUR_MS)).toBe(tokyo("2026-11-20", "12:00"));
    expect(latestStartSlot(settings(), tokyo("2026-11-20", "05:00"), HOUR_MS)).toBeNull();
  });
});
