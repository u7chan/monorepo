// ロックの残り時間と期限バナーの境界を、時計を渡す純関数として固定する。
import { describe, expect, test } from "bun:test";
import { describeWait, expiryDaysLeft, EXPIRY_NOTICE_MS, lockSecondsLeft } from "../src/client/time";

const now = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("lockSecondsLeft", () => {
  test("残り時間を秒に切り上げ、期限を過ぎたら 0", () => {
    expect(lockSecondsLeft(now + 900_000, now)).toBe(900);
    expect(lockSecondsLeft(now + 1, now)).toBe(1);
    expect(lockSecondsLeft(now, now)).toBe(0);
    expect(lockSecondsLeft(now - 1, now)).toBe(0);
  });
});

describe("expiryDaysLeft", () => {
  test("3 日以内だけ残り日数を返す", () => {
    expect(expiryDaysLeft(now + EXPIRY_NOTICE_MS, now)).toBe(3);
    expect(expiryDaysLeft(now + EXPIRY_NOTICE_MS + 1, now)).toBeNull();
    expect(expiryDaysLeft(now + 2.5 * DAY, now)).toBe(3);
    expect(expiryDaysLeft(now + 1, now)).toBe(1);
  });

  test("期限切れは null", () => {
    expect(expiryDaysLeft(now, now)).toBeNull();
    expect(expiryDaysLeft(now - DAY, now)).toBeNull();
  });
});

describe("describeWait", () => {
  test("1 分未満は秒、以上は分で表す", () => {
    expect(describeWait(1)).toBe("1 秒");
    expect(describeWait(59)).toBe("59 秒");
    expect(describeWait(60)).toBe("1 分");
    expect(describeWait(900)).toBe("15 分");
  });
});
