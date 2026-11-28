// 画面に出す文言の境界（まもなく / 分 / 時間 / 日、% の丸め、日時）を固定する。
import { describe, expect, test } from "bun:test";
import {
  describeAge,
  describeCoverage,
  describeRemaining,
  describeReset,
  describeResetCredits,
  formatClock,
  formatDateTime,
  formatFetchInterval,
  formatMonthDay,
  formatPercent,
  formatSpan,
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

describe("describeResetCredits", () => {
  const now = new Date(2026, 10, 28, 12, 0).getTime();

  test("回数が 0 なら行を出さない", () => {
    expect(describeResetCredits({ available: 0, expiries: [now + DAY] }, now)).toBeNull();
  });

  test("期限を取れていなければ回数だけを出し、期限を推測しない", () => {
    expect(describeResetCredits({ available: 2, expiries: null }, now)).toEqual({
      label: "リセット枠 2回",
      rows: [],
      note: null,
    });
  });

  test("期限は全部の枠を昇順で出し、残り時間を添える", () => {
    expect(describeResetCredits({ available: 2, expiries: [now + 28 * DAY, now + 15 * DAY] }, now)).toEqual({
      label: "リセット枠 2回",
      rows: [
        { remaining: "あと 15 日", at: `期限 ${formatDateTime(now + 15 * DAY)}` },
        { remaining: "あと 28 日", at: `期限 ${formatDateTime(now + 28 * DAY)}` },
      ],
      note: null,
    });
  });

  test("期限の無い枠だけなら期限なしと出す", () => {
    expect(describeResetCredits({ available: 1, expiries: [] }, now)).toEqual({
      label: "リセット枠 1回",
      rows: [],
      note: "期限なし",
    });
  });

  test("一覧が回数より少なければ、残りを期限不明として出す", () => {
    expect(describeResetCredits({ available: 3, expiries: [now + DAY] }, now)).toEqual({
      label: "リセット枠 3回",
      rows: [{ remaining: "あと 1 日", at: `期限 ${formatDateTime(now + DAY)}` }],
      note: "他 2件は期限不明",
    });
  });

  test("期限を過ぎた枠は期限切れと出す", () => {
    expect(describeResetCredits({ available: 1, expiries: [now - HOUR] }, now)).toEqual({
      label: "リセット枠 1回",
      rows: [{ remaining: "期限切れ", at: `期限 ${formatDateTime(now - HOUR)}` }],
      note: null,
    });
  });
});

describe("formatDateTime / formatClock", () => {
  test("ブラウザのローカル時刻で MM/DD HH:MM を出す", () => {
    const at = new Date(2026, 9, 31, 9, 5).getTime();

    expect(formatMonthDay(at)).toBe("10/31");
    expect(formatDateTime(at)).toBe("10/31 09:05");
    expect(formatClock(at)).toBe("09:05");
  });
});

describe("formatSpan / describeCoverage", () => {
  test("推移の見出しは 1 つの単位へ丸める", () => {
    expect(formatSpan(30 * MINUTE)).toBe("30分");
    expect(formatSpan(5 * HOUR)).toBe("5時間");
    expect(formatSpan(1.5 * HOUR)).toBe("2時間");
    expect(formatSpan(7 * DAY)).toBe("7日");
    expect(formatSpan(30 * DAY)).toBe("30日");
    expect(formatSpan(Number.NaN)).toBe("0分");
  });

  test("履歴の長さは単位を 1 つだけ付ける", () => {
    expect(describeCoverage(10 * MINUTE)).toBe("10 分");
    expect(describeCoverage(5 * HOUR)).toBe("5 時間分");
    expect(describeCoverage(3 * DAY + 2 * HOUR)).toBe("3 日分");
    expect(describeCoverage(30 * 1000)).toBe("1 分");
  });
});

describe("fetch interval and age", () => {
  test("取得間隔は分で出す", () => {
    expect(formatFetchInterval(5 * MINUTE)).toBe("5 分");
    expect(formatFetchInterval(10 * MINUTE)).toBe("10 分");
    expect(formatFetchInterval(2 * HOUR)).toBe("120 分");
    // 0 は「0 分間隔」と出さず、下限へ寄せる。
    expect(formatFetchInterval(0)).toBe("1 分");
  });

  test("経過は切り捨てで出す", () => {
    expect(describeAge(-1000)).toBe("たった今");
    expect(describeAge(MINUTE - 1)).toBe("たった今");
    expect(describeAge(MINUTE)).toBe("1 分前");
    expect(describeAge(12 * MINUTE + 59_000)).toBe("12 分前");
    expect(describeAge(HOUR)).toBe("1 時間前");
    expect(describeAge(2 * DAY + 23 * HOUR)).toBe("2 日前");
    expect(describeAge(Number.NaN)).toBe("たった今");
  });
});

describe("describeReset", () => {
  test("リセット日時と残り時間を 1 行にする", () => {
    const now = new Date(2026, 9, 28, 9, 0).getTime();
    const resetsAt = new Date(2026, 9, 31, 9, 0).getTime();

    expect(describeReset(resetsAt, now)).toEqual({ at: "リセット 10/31 09:00", remaining: "あと 3 日" });
  });

  test("ローリングは日付を省き、日をまたぐときだけ翌を付ける", () => {
    const now = new Date(2026, 9, 28, 9, 0).getTime();

    expect(describeReset(new Date(2026, 9, 28, 12, 0).getTime(), now, { rolling: true })).toEqual({
      at: "リセット 12:00",
      remaining: "あと 3 時間",
    });
    expect(describeReset(new Date(2026, 9, 28, 0, 5).getTime(), now, { rolling: true })?.at).toBe("リセット 00:05");
    expect(describeReset(new Date(2026, 9, 29, 2, 0).getTime(), now, { rolling: true })?.at).toBe("リセット 翌 02:00");
  });

  test("ローリングでも 2 日以上先なら日付ごと出す", () => {
    const now = new Date(2026, 9, 28, 9, 0).getTime();

    expect(describeReset(new Date(2026, 9, 31, 2, 0).getTime(), now, { rolling: true })?.at).toBe(
      "リセット 10/31 02:00",
    );
  });

  test("時刻が無ければ null", () => {
    expect(describeReset(null, 0)).toBeNull();
    expect(describeReset(Number.NaN, 0)).toBeNull();
  });
});
