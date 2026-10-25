// 窓の種類分けと、重複ラベルの一意化を固定する。
import { describe, expect, test } from "bun:test";
import { windowKind, withUniqueLabels, type UsageWindow } from "../src/server/providers/types";

function window(id: string, label: string, durationSeconds: number | null = null): UsageWindow {
  return { id, label, durationSeconds, usedPercent: 10, resetsAt: null };
}

describe("windowKind", () => {
  test("6 時間以下は rolling、8 日以下は weekly、それ以上は monthly", () => {
    expect(windowKind(18_000)).toBe("rolling");
    expect(windowKind(6 * 3600)).toBe("rolling");
    expect(windowKind(6 * 3600 + 1)).toBe("weekly");
    expect(windowKind(8 * 24 * 3600)).toBe("weekly");
    expect(windowKind(8 * 24 * 3600 + 1)).toBe("monthly");
  });

  test("読めない値は rolling に寄せる", () => {
    expect(windowKind(null)).toBe("rolling");
    expect(windowKind(0)).toBe("rolling");
  });
});

describe("withUniqueLabels", () => {
  test("重複が無ければラベルを変えない", () => {
    expect(withUniqueLabels([window("a", "週次"), window("b", "ローリング")]).map((item) => item.label)).toEqual([
      "週次",
      "ローリング",
    ]);
  });

  test("重複したら短い期間から第1枠 / 第2枠を付ける", () => {
    const labelled = withUniqueLabels([window("long", "ローリング", 21_600), window("short", "ローリング", 18_000)]);

    expect(labelled.map((item) => [item.id, item.label])).toEqual([
      ["long", "ローリング（第2枠）"],
      ["short", "ローリング（第1枠）"],
    ]);
  });
});
