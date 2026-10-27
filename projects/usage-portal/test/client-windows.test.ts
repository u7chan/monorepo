// 推移の初期表示は週次。週次が無いときだけ先頭の窓を出す。
import { describe, expect, test } from "bun:test";
import type { UsageWindow } from "../src/client/api";
import { pickTrendWindow } from "../src/client/lib/windows";

function window(id: string, label: string): UsageWindow {
  return { id, label, durationSeconds: null, usedPercent: 10, resetsAt: null };
}

describe("pickTrendWindow", () => {
  test("Codex と OpenCode Go のどちらも週次を選ぶ", () => {
    expect(pickTrendWindow([window("primary", "ローリング"), window("secondary", "週次")])?.id).toBe("secondary");
    expect(
      pickTrendWindow([window("rolling", "ローリング"), window("weekly", "週次"), window("monthly", "月次")])?.id,
    ).toBe("weekly");
  });

  test("重複ラベルで第 N 枠が付いても週次を選ぶ", () => {
    expect(pickTrendWindow([window("primary", "ローリング"), window("secondary", "週次（第1枠）")])?.id).toBe(
      "secondary",
    );
  });

  test("週次が無ければ先頭、窓が無ければ null", () => {
    expect(pickTrendWindow([window("primary", "ローリング")])?.id).toBe("primary");
    expect(pickTrendWindow([])).toBeNull();
  });
});
