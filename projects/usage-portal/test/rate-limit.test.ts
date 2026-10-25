// 5 回失敗で 15 分ロックし、窓が過ぎたら再び試せることを固定する。
import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "../src/server/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;

function limiter() {
  let clock = 0;

  return {
    limiter: createRateLimiter({ maxFailures: 5, windowMs: WINDOW_MS, now: () => clock }),
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createRateLimiter", () => {
  test("5 回目の失敗までは通り、5 回で残り時間を返す", () => {
    const { limiter: rate } = limiter();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(rate.retryAfterSeconds("client")).toBeNull();
      rate.recordFailure("client");
    }

    expect(rate.retryAfterSeconds("client")).toBeNull();

    rate.recordFailure("client");

    expect(rate.retryAfterSeconds("client")).toBe(15 * 60);
  });

  test("窓を過ぎるとロックが解ける", () => {
    const { limiter: rate, advance } = limiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      rate.recordFailure("client");
    }

    advance(WINDOW_MS - 1000);

    expect(rate.retryAfterSeconds("client")).toBe(1);

    advance(1000);

    expect(rate.retryAfterSeconds("client")).toBeNull();
  });

  test("成功時の reset で失敗履歴が消え、キーごとに独立している", () => {
    const { limiter: rate } = limiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      rate.recordFailure("a");
    }

    expect(rate.retryAfterSeconds("b")).toBeNull();

    rate.reset("a");

    expect(rate.retryAfterSeconds("a")).toBeNull();
  });
});
