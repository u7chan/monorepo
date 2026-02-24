import { describe, test, expect } from "bun:test";
import { calculate } from "../src/index";

describe("example-lib-b", () => {
  describe("calculate", () => {
    test("1 + 2 = 3", () => {
      expect(calculate(1, 2)).toBe(3);
    });

    test("0 + 0 = 0", () => {
      expect(calculate(0, 0)).toBe(0);
    });

    test("-1 + -1 = -2", () => {
      expect(calculate(-1, -1)).toBe(-2);
    });
  });
});
