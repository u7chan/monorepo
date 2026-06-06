import { describe, expect, test } from "bun:test";
import { hexColorToRgb, normalizeHexColor } from "../src/colors.js";

describe("normalizeHexColor", () => {
  test("6桁hex色を小文字へ正規化する", () => {
    expect(normalizeHexColor("#A1B2C3", "#000000")).toBe("#a1b2c3");
  });

  test("不正な値はfallbackにする", () => {
    expect(normalizeHexColor("red", "#0f1214")).toBe("#0f1214");
    expect(normalizeHexColor(null, "#0f1214")).toBe("#0f1214");
  });
});

describe("hexColorToRgb", () => {
  test("hex色をWebGL向けの0-1 RGBへ変換する", () => {
    expect(hexColorToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexColorToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexColorToRgb("#804020")).toEqual([
      128 / 255,
      64 / 255,
      32 / 255,
    ]);
  });
});
