// 画面に出す文言の境界（まもなく / 分 / 時間 / 日、% の丸め、日時）を固定する。
import { describe, expect, test } from "bun:test";
import {
  describeRemaining,
  describeReset,
  formatClock,
  formatDateTime,
  formatPercent,
  remainingPercent,
} from "../src/client/lib/format";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("describeRemaining", () => {
  test("1 分未満はまもなく、1 時間未満は分で出す", () => {
    expect(describeRemaining(0)).toBe("まもなく");
    expect(describeRemaining(-1000)).toBe("まもなく");
    expect(describeRemaining(MINUTE - 1)).toBe("まもなく");
    expect(describeRemaining(MINUTE)).toBe("1 分");
    expect(describeRemaining(12 * MINUTE)).toBe("12 分");
    expect(describeRemaining(59.5 * MINUTE)).toBe("60 分");
  });

  test("24 時間未満は時間、それ以上は日で出す", () => {
    expect(describeRemaining(HOUR)).toBe("1 時間");
    expect(describeRemaining(23.5 * HOUR)).toBe("24 時間");
    expect(describeRemaining(DAY)).toBe("1 日");
    expect(describeRemaining(3 * DAY + 1)).toBe("4 日");
  });
});

describe("formatPercent / remainingPercent", () => {
  test("整数へ丸め、0〜100 に収める", () => {
    expect(formatPercent(62.4)).toBe("62%");
    expect(formatPercent(0.5)).toBe("1%");
    expect(formatPercent(100.4)).toBe("100%");
    expect(formatPercent(-5)).toBe("0%");
    expect(remainingPercent(62)).toBe(38);
    expect(remainingPercent(120)).toBe(0);
    expect(remainingPercent(-1)).toBe(100);
  });
});

describe("formatDateTime / formatClock", () => {
  test("ブラウザのローカル時刻で MM/DD HH:MM を出す", () => {
    const at = new Date(2026, 9, 31, 9, 5).getTime();

    expect(formatDateTime(at)).toBe("10/31 09:05");
    expect(formatClock(at)).toBe("09:05");
  });
});

describe("describeReset", () => {
  test("リセット日時と残り時間を 1 行にする", () => {
    const now = new Date(2026, 9, 28, 9, 0).getTime();
    const resetsAt = new Date(2026, 9, 31, 9, 0).getTime();

    expect(describeReset(resetsAt, now)).toEqual({ at: "リセット 10/31 09:00", remaining: "あと 3 日" });
  });

  test("時刻が無ければ null", () => {
    expect(describeReset(null, 0)).toBeNull();
    expect(describeReset(Number.NaN, 0)).toBeNull();
  });
});
