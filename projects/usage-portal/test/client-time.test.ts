// ロックの残り時間と期限バナーの境界を、時計を渡す純関数として固定する。
import { describe, expect, test } from "bun:test";
import { describeWait, expiryNotice, EXPIRY_NOTICE_MS, lockSecondsLeft } from "../src/client/time";

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

describe("expiryNotice", () => {
  test("3 日以内だけ「あと」の文言を返す", () => {
    expect(expiryNotice(now + EXPIRY_NOTICE_MS, now)).toBe("3 日");
    expect(expiryNotice(now + EXPIRY_NOTICE_MS + 1, now)).toBeNull();
    expect(expiryNotice(now + 2.5 * DAY, now)).toBe("3 日");
    expect(expiryNotice(now + 1, now)).toBe("まもなく");
  });

  test("1 日未満は時間、1 時間未満は分で出す", () => {
    expect(expiryNotice(now + 23 * 60 * 60 * 1000, now)).toBe("23 時間");
    expect(expiryNotice(now + 59 * 60 * 1000, now)).toBe("59 分");
  });

  test("期限切れは null", () => {
    expect(expiryNotice(now, now)).toBeNull();
    expect(expiryNotice(now - DAY, now)).toBeNull();
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
