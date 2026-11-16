import { describe, expect, test } from "bun:test";
import { formatCost, formatFetchedAt } from "../src/shared/format";

describe("formatCost", () => {
  test("単位ごとの接尾辞を付ける（token は 1M あたりへ揃える）", () => {
    expect(formatCost(0.041, "image")).toBe("$0.041/枚");
    expect(formatCost(0.03, "megapixel")).toBe("$0.03/MP");
    expect(formatCost(0.00003, "token")).toBe("$30/1M tok");
    expect(formatCost(0.02, "request")).toBe("$0.02/回");
  });

  test("小数の末尾 0 を残さない", () => {
    expect(formatCost(0.06, "image")).toBe("$0.06/枚");
    expect(formatCost(0.5, "image")).toBe("$0.5/枚");
  });

  test("宣言された 0 は $0 として出す（不明と混ぜない）", () => {
    expect(formatCost(0, "image")).toBe("$0/枚");
  });

  test("token の換算で浮動小数の誤差を出さない", () => {
    expect(formatCost(0.000066, "token")).toBe("$66/1M tok");
    expect(formatCost(0.00012, "token")).toBe("$120/1M tok");
  });

  test("未知の単位・不正な値は整形しない", () => {
    expect(formatCost(0.02, "second")).toBe("--");
    expect(formatCost(Number.NaN, "image")).toBe("--");
    expect(formatCost(-1, "image")).toBe("--");
  });
});

describe("formatFetchedAt", () => {
  test("JST の分までを固定幅で返す", () => {
    expect(formatFetchedAt(Date.UTC(2026, 10, 16, 13, 5))).toBe("2026-11-16 22:05");
  });

  test("読めない値は --", () => {
    expect(formatFetchedAt(Number.NaN)).toBe("--");
  });
});
